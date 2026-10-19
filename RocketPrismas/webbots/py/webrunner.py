"""Corre un bot de RLBotPack dentro de Pyodide (navegador). Usa el mini-paquete `rlbot` de esta carpeta."""
import os, sys, json, importlib
from botworker import Env, _controls, _find_class, _Dummy

_agents = {}
_env = None


def init(spec_json):
    global _env, _agents
    spec = json.loads(spec_json)
    bot_dir = spec['dir']
    os.chdir(bot_dir)
    sys.path.insert(0, bot_dir)
    from rlbot.agents.base_agent import BaseAgent
    module = importlib.import_module(os.path.splitext(spec['pythonFile'])[0])
    cls = _find_class(module, BaseAgent)
    names, teams = spec['names'], spec['teams']
    _env = Env(names, teams)
    _agents = {}
    for idx in spec['indices']:
        a = cls(names[idx], teams[idx], idx)
        a.spawn_id = idx + 1
        a._field_info_func = lambda: _env.field
        a._ball_pred_func = _env.ball_prediction
        a.renderer = _Dummy()
        a.load_config(None)
        _agents[idx] = a
    first = {'time': 0.0, 'active': False, 'kick': True,
             'ball': {'p': [0, 0, 93.0], 'v': [0, 0, 0], 'w': [0, 0, 0]},
             'cars': [{'p': [0, 0, 17], 'v': [0, 0, 0], 'w': [0, 0, 0], 'r': [1, 0, 0, 0, 1, 0, 0, 0, 1],
                       'b': 33, 'g': 1, 'j': 0, 'd': 0, 's': 0} for _ in teams]}
    _env.update(first)
    for a in _agents.values():
        a.initialize_agent()
    return 'ok'


def step(state_json):
    s = json.loads(state_json)
    packet = _env.update(s)
    res = {}
    for i, a in _agents.items():
        res[i] = _controls(a.get_output(packet))
    return json.dumps(res)


def chats():
    """Quick chats emitidos por los bots desde la ultima llamada (para mostrarlos como aviso)."""
    from rlbot.agents import base_agent
    out = [[i, n] for (i, n) in base_agent.CHATS]
    del base_agent.CHATS[:]
    return json.dumps(out)
