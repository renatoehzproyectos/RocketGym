"""Un proceso por bot (o por equipo, para los hiveminds). Carga el bot de RLBotPack tal cual,
le da un GameTickPacket real de rlbot construido desde el estado del juego web y devuelve controles."""
import os, sys, math, struct, ctypes, types, importlib.util, traceback, queue as _queue

BOOST_PADS = [(0,-4240,0),(-1792,-4184,0),(1792,-4184,0),(-3072,-4096,1),(3072,-4096,1),(-940,-3308,0),(940,-3308,0),
 (0,-2816,0),(-3584,-2484,0),(3584,-2484,0),(-1788,-2300,0),(1788,-2300,0),(-2048,-1036,0),(0,-1024,0),(2048,-1036,0),
 (-1024,0,0),(1024,0,0),(-3584,0,1),(3584,0,1),(-2048,1036,0),(0,1024,0),(2048,1036,0),(-1788,2300,0),(1788,2300,0),
 (-3584,2484,0),(3584,2484,0),(0,2816,0),(-940,3308,0),(940,3308,0),(-3072,4096,1),(3072,4096,1),(-1792,4184,0),
 (1792,4184,0),(0,4240,0)]


def install_imp_shim():
    """rlbot->flatbuffers hacen `import imp`, que no existe en Python 3.12+."""
    if 'imp' in sys.modules:
        return
    try:
        import imp  # noqa
        return
    except ImportError:
        pass
    m = types.ModuleType('imp')
    def find_module(name, path=None):
        if importlib.util.find_spec(name) is None:
            raise ImportError(name)
        return (None, None, None)
    m.find_module = find_module
    sys.modules['imp'] = m


class _Dummy:
    """Renderer / matchcomms de mentira: acepta cualquier llamada y no hace nada."""
    def __getattr__(self, k):
        if k.startswith('__'):
            raise AttributeError(k)
        return _Dummy()
    def __call__(self, *a, **k):
        return _Dummy()
    def __iter__(self):
        return iter(())
    def __enter__(self): return self
    def __exit__(self, *a): return False


class _Comms:
    def __init__(self):
        self.incoming_broadcast = _queue.Queue()
        self.outgoing_broadcast = _queue.Queue()
    def close(self): pass


def rotator(rot):
    fx, fy, fz, ux, uy, uz = rot[0], rot[1], rot[2], rot[6], rot[7], rot[8]
    h = math.hypot(fx, fy)
    yaw = math.atan2(fy, fx)
    pitch = math.atan2(fz, h)
    cp = h
    if cp > 1e-4:
        sy, cy = fy / h, fx / h
        sr = ux * -sy + uy * cy
        roll = math.atan2(sr, uz / cp)
    else:
        roll = 0.0
    return pitch, yaw, roll


class BallSim:
    R = 91.25
    def __init__(self):
        self.cache_key = None
    def predict(self, bp, ball, t0):
        key = (round(t0, 4))
        if key == self.cache_key:
            return
        self.cache_key = key
        R = self.R; g = -650.0; dt = 1 / 120.0; e = 0.6
        x, y, z = ball['p']; vx, vy, vz = ball['v']; wx, wy, wz = ball['w']
        n = 360                      # el struct BallPrediction de rlbot 1.68 guarda 360 slices (6 s a 60 Hz)
        out = []
        ap = out.append
        diag = 8064.0 - R * 1.4142
        for i in range(n):
            ap(x); ap(y); ap(z); ap(0.0); ap(0.0); ap(0.0); ap(vx); ap(vy); ap(vz); ap(wx); ap(wy); ap(wz); ap(t0 + i / 60.0)
            for _sub in range(2):
                vz += g * dt
                sp2 = vx * vx + vy * vy + vz * vz
                if sp2 > 36e6:
                    k = 6000.0 / math.sqrt(sp2); vx *= k; vy *= k; vz *= k
                x += vx * dt; y += vy * dt; z += vz * dt
                ay = abs(y)
                ingoal = ay > 5120 - R and abs(x) < 892.0 and z < 642.0
                if z < R:
                    z = R
                    if vz < 0:
                        vz = -vz * e if vz < -120 else 0.0
                elif z > 2044 - R:
                    z = 2044 - R
                    if vz > 0: vz = -vz * e
                if ingoal:
                    lim = 892.0 - R
                    if abs(x) > lim:
                        x = lim if x > 0 else -lim
                        if vx * x > 0: vx = -vx * e
                    if ay > 6000 - R:
                        y = (6000 - R) * (1 if y > 0 else -1)
                        if vy * y > 0: vy = -vy * e
                    if z > 642 - R:
                        z = 642 - R
                        if vz > 0: vz = -vz * e
                    continue
                if abs(x) > 4096 - R:
                    x = (4096 - R) * (1 if x > 0 else -1)
                    if vx * x > 0: vx = -vx * e
                if ay > 5120 - R:
                    y = (5120 - R) * (1 if y > 0 else -1)
                    if vy * y > 0: vy = -vy * e
                d = abs(x) + abs(y)
                if d > diag:
                    sx = 1 if x > 0 else -1; sy_ = 1 if y > 0 else -1
                    ex = (d - diag) * 0.5
                    x -= sx * ex; y -= sy_ * ex
                    vn = vx * sx + vy * sy_
                    if vn > 0:
                        vx -= (1 + e) * vn * 0.5 * sx; vy -= (1 + e) * vn * 0.5 * sy_
        data = struct.pack('<%df' % len(out), *out)
        assert len(data) == n * ctypes.sizeof(type(bp.slices[0]))
        ctypes.memmove(ctypes.addressof(bp.slices), data, len(data))
        bp.num_slices = n


class Env:
    """Construye GameTickPacket / FieldInfo / BallPrediction desde el estado JSON."""
    def __init__(self, names, teams):
        from rlbot.utils.structures import game_data_struct as g
        from rlbot.utils.structures.ball_prediction_struct import BallPrediction
        self.g = g
        self.names = names; self.teams = teams
        self.packet = g.GameTickPacket()
        self.field = g.FieldInfoPacket()
        self.ball_pred = BallPrediction()
        self.sim = BallSim()
        self.last = None
        n = len(teams)
        p = self.packet
        p.num_cars = n; p.num_boost = len(BOOST_PADS); p.num_teams = 2
        for i in range(n):
            c = p.game_cars[i]
            c.name = names[i]; c.team = teams[i]; c.is_bot = (i != 0); c.spawn_id = i + 1
            c.hitbox.length, c.hitbox.width, c.hitbox.height = 118.0, 84.2, 36.16
            c.hitbox_offset.x, c.hitbox_offset.y, c.hitbox_offset.z = 13.88, 0.0, 20.75
        p.teams[0].team_index = 0; p.teams[1].team_index = 1
        p.game_ball.collision_shape.type = 1
        p.game_ball.collision_shape.sphere.diameter = 182.5
        p.game_info.world_gravity_z = -650.0
        p.game_info.game_speed = 1.0
        p.game_info.is_unlimited_time = True
        p.game_info.game_time_remaining = 300.0
        f = self.field
        f.num_boosts = len(BOOST_PADS)
        for i, (x, y, big) in enumerate(BOOST_PADS):
            f.boost_pads[i].location.x = x; f.boost_pads[i].location.y = y
            f.boost_pads[i].location.z = 73.0 if big else 70.0
            f.boost_pads[i].is_full_boost = bool(big)
        f.num_goals = 2
        for i, sgn in enumerate((-1, 1)):
            gl = f.goals[i]
            gl.team_num = i
            gl.location.x = 0; gl.location.y = 5120.0 * sgn; gl.location.z = 321.3875
            gl.direction.x = 0; gl.direction.y = -sgn; gl.direction.z = 0
            gl.width = 1784.0; gl.height = 642.775

    def update(self, s):
        p = self.packet
        self.last = s
        gi = p.game_info
        gi.seconds_elapsed = s['time']; gi.frame_num = int(s['time'] * 120)
        gi.is_round_active = bool(s['active']); gi.is_kickoff_pause = bool(s['kick'])
        b = s['ball']; ph = p.game_ball.physics
        ph.location.x, ph.location.y, ph.location.z = b['p']
        ph.velocity.x, ph.velocity.y, ph.velocity.z = b['v']
        ph.angular_velocity.x, ph.angular_velocity.y, ph.angular_velocity.z = b['w']
        for i, c in enumerate(s['cars']):
            ci = p.game_cars[i]; ph = ci.physics
            ph.location.x, ph.location.y, ph.location.z = c['p']
            ph.velocity.x, ph.velocity.y, ph.velocity.z = c['v']
            ph.angular_velocity.x, ph.angular_velocity.y, ph.angular_velocity.z = c['w']
            ph.rotation.pitch, ph.rotation.yaw, ph.rotation.roll = rotator(c['r'])
            ci.boost = int(round(c['b'])); ci.has_wheel_contact = bool(c['g'])
            ci.jumped = bool(c['j']); ci.double_jumped = bool(c['d']); ci.is_super_sonic = bool(c['s'])
        t = s.get('touch')
        if t:
            lt = p.game_ball.latest_touch
            lt.player_name = self.names[t['i']]; lt.player_index = t['i']; lt.team = self.teams[t['i']]
            lt.time_seconds = t['t']
            lt.hit_location.x, lt.hit_location.y, lt.hit_location.z = t['p']
            lt.hit_normal.x, lt.hit_normal.y, lt.hit_normal.z = t['n']
        for i in range(len(BOOST_PADS)):
            p.game_boosts[i].is_active = True; p.game_boosts[i].timer = 0.0
        return p

    def ball_prediction(self):
        if self.last is not None:
            self.sim.predict(self.ball_pred, self.last['ball'], self.last['time'])
        return self.ball_pred


def _match_settings():
    try:
        from flatbuffers import Builder
        from rlbot.messages.flat import MatchSettings, MutatorSettings
        b = Builder(256)
        MutatorSettings.MutatorSettingsStart(b); ms = MutatorSettings.MutatorSettingsEnd(b)
        MatchSettings.MatchSettingsStart(b)
        MatchSettings.MatchSettingsAddMutatorSettings(b, ms)
        MatchSettings.MatchSettingsAddGameMode(b, 0)
        b.Finish(MatchSettings.MatchSettingsEnd(b))
        return MatchSettings.MatchSettings.GetRootAsMatchSettings(bytes(b.Output()), 0)
    except Exception:
        return _Dummy()


def _match_config():
    from rlbot.matchconfig.match_config import MatchConfig, MutatorConfig
    mc = MatchConfig()
    mc.mutators = MutatorConfig()
    for k, v in dict(match_length='5 Minutes', max_score='Default', overtime='Unlimited', series_length='Unlimited',
                     game_speed='Default', ball_max_speed='Default', ball_type='Default', ball_weight='Default',
                     ball_size='Default', ball_bounciness='Default', boost_amount='Default', rumble='None',
                     boost_strength='1x', gravity='Default', demolish='Default', respawn_time='3 Seconds').items():
        setattr(mc.mutators, k, v)
    mc.game_mode = 'Soccer'
    mc.game_map = 'DFHStadium'
    return mc


def _controls(o):
    g = lambda k, d=0.0: getattr(o, k, d)
    return [float(g('throttle')), float(g('steer')), float(g('pitch')), float(g('yaw')), float(g('roll')),
            bool(g('jump', False)), bool(g('boost', False)), bool(g('handbrake', False))]


def _find_class(module, base):
    import inspect
    cands = [c for _, c in inspect.getmembers(module, inspect.isclass)
             if issubclass(c, base) and c.__module__ == module.__name__]
    if not cands:
        cands = [c for _, c in inspect.getmembers(module, inspect.isclass) if issubclass(c, base) and c is not base]
    return cands[0] if cands else None


def worker_main(conn, spec):
    install_imp_shim()
    try:
        bot_dir = os.path.dirname(os.path.abspath(spec['cfg']))
        os.chdir(bot_dir)
        sys.path.insert(0, bot_dir)
        sys.path.insert(0, os.path.join(spec['pack'], 'L0laapk3_shared'))  # rlutilities compartido (Bribblebot)
        from rlbot.agents.base_agent import BaseAgent
        from rlbot.parsing.bot_config_bundle import get_bot_config_bundle
        bundle = get_bot_config_bundle(os.path.abspath(spec['cfg']))
        pyfile = os.path.join(bot_dir, spec['pythonFile'])
        mod_name = os.path.splitext(os.path.basename(pyfile))[0]
        module = importlib.import_module(mod_name)
        cls = _find_class(module, BaseAgent)
        cfgobj = BaseAgent.base_create_agent_configurations()
        try:
            cls.create_agent_configurations(cfgobj)
        except Exception:
            pass
        cfgobj.parse_file(bundle.config_obj, config_directory=bot_dir)
        params = cfgobj.get_header('Bot Parameters')
        names = spec['names']; teams = spec['teams']
        env = Env(names, teams)
        agents = {}      # index -> agent
        hive = None
        from rlbot.agents.hivemind.drone_agent import DroneAgent
        from rlbot.agents.hivemind.python_hivemind import PythonHivemind
        if cls is not None and issubclass(cls, DroneAgent):
            hive_file = cls.hive_path
            hdir = os.path.dirname(os.path.abspath(hive_file))
            sys.path.insert(0, hdir)
            hmod = importlib.import_module(os.path.splitext(os.path.basename(hive_file))[0])
            hcls = _find_class(hmod, PythonHivemind)
            import multiprocessing as mp, threading
            hive = hcls(mp.Queue(), threading.Event(), {'name': getattr(cls, 'hive_name', spec['name']), 'team': spec['team']})
            hive.drone_indices = set(spec['indices'])
            hive.matchcomms_root = 'ws://127.0.0.1:0/'
            hive._field_info = env.field
            hive._ball_prediction = env.ball_pred
            hive.team = spec['team']
            hive.renderer = _Dummy()
            hive.get_ball_prediction_struct = env.ball_prediction
            hive.get_field_info = lambda: env.field
            hive.get_match_settings = _match_settings
            hive.set_game_state = lambda *a, **k: None
        else:
            if cls is None:
                raise RuntimeError('No se encontró ninguna clase BaseAgent en ' + pyfile)
            for idx in spec['indices']:
                a = cls(names[idx], teams[idx], idx)
                a._set_spawn_id(idx + 1)
                a.matchcomms_root = 'ws://127.0.0.1:0/'  # falso: se usa _Comms
                a.init_match_config(_match_config())
                a._matchcomms = _Comms()
                a.load_config(params)
                a._register_quick_chat(lambda *x, **k: None)
                a._register_field_info(lambda: env.field)
                a._register_set_game_state(lambda *x, **k: None)
                a._register_ball_prediction(lambda: env.ball_pred)
                a._register_ball_prediction_struct(env.ball_prediction)
                a._register_get_rigid_body_tick(lambda: None)
                a._register_match_settings_func(_match_settings)
                a._set_renderer(_Dummy())
                agents[idx] = a
        first = {'time': 0.0, 'active': False, 'kick': True,
                 'ball': {'p': [0, 0, 93.0], 'v': [0, 0, 0], 'w': [0, 0, 0]},
                 'cars': [{'p': [0, 0, 17], 'v': [0, 0, 0], 'w': [0, 0, 0], 'r': [1, 0, 0, 0, 1, 0, 0, 0, 1],
                           'b': 33, 'g': 1, 'j': 0, 'd': 0, 's': 0} for _ in teams]}
        env.update(first)
        if hive is not None:
            hive.initialize_hive(env.packet)
        else:
            for a in agents.values():
                a.initialize_agent()
        conn.send({'t': 'ready', 'ok': True})
    except BaseException as e:
        conn.send({'t': 'ready', 'ok': False, 'err': '%s: %s' % (type(e).__name__, e), 'tb': traceback.format_exc()})
        return

    errors = 0
    while True:
        try:
            msg = conn.recv()
        except (EOFError, OSError):
            return
        if msg is None or msg.get('t') == 'quit':
            return
        try:
            packet = env.update(msg)
            res = {}
            if hive is not None:
                outs = hive.get_outputs(packet) or {}
                for i, o in outs.items():
                    res[i] = _controls(o)
            else:
                for i, a in agents.items():
                    res[i] = _controls(a.get_output(packet))
            conn.send({'t': 'ctl', 'c': res})
        except Exception as e:
            errors += 1
            if errors <= 3:
                traceback.print_exc()
            conn.send({'t': 'ctl', 'c': {}, 'err': '%s: %s' % (type(e).__name__, e)})
