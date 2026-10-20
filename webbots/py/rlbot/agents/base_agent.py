BOT_CONFIG_MODULE_HEADER = 'Locations'
class SimpleControllerState:
    def __init__(self, steer=0.0, throttle=0.0, pitch=0.0, yaw=0.0, roll=0.0, jump=False, boost=False, handbrake=False, use_item=False):
        self.steer = steer; self.throttle = throttle; self.pitch = pitch; self.yaw = yaw; self.roll = roll
        self.jump = jump; self.boost = boost; self.handbrake = handbrake; self.use_item = use_item
CHATS = []   # mensajes de quick chat pendientes de enviar al navegador: [(index, nombre)]


class BaseAgent:
    def __init__(self, name, team, index):
        self.name = name; self.team = team; self.index = index; self.spawn_id = -1
        import logging
        self.logger = logging.getLogger('bot%d' % index)
        self.renderer = None; self.matchcomms_root = None; self.match_config = None
    def get_output(self, packet): return SimpleControllerState()
    def initialize_agent(self): pass
    def retire(self): pass
    def load_config(self, header): pass
    def init_match_config(self, mc): self.match_config = mc
    def is_hot_reload_enabled(self): return False
    def send_quick_chat(self, team_only, quick_chat):
        if isinstance(quick_chat, str): CHATS.append((self.index, quick_chat))
    def handle_quick_chat(self, index, team, quick_chat): pass
    def get_field_info(self): return self._field_info_func()
    def get_ball_prediction_struct(self): return self._ball_pred_func()
    def get_ball_prediction(self): return None
    def set_game_state(self, gs): pass
    def get_match_settings(self): return _MatchSettings()
    def get_rigid_body_tick(self): return None
    @classmethod
    def base_create_agent_configurations(cls): return None

BOT_CONFIG_AGENT_HEADER = 'Bot Parameters'
BOT_NAME_KEY = 'name'; LOOKS_CONFIG_KEY = 'looks_config'; PYTHON_FILE_KEY = 'python_file'
LOGO_FILE_KEY = 'logo_file'; SUPPORTS_EARLY_START_KEY = 'supports_early_start'
LOADOUT_GENERATOR_FILE_KEY = 'loadout_generator'; MAXIMUM_TICK_RATE_PREFERENCE_KEY = 'maximum_tick_rate_preference'
SUPPORTS_STANDALONE = 'supports_standalone'


class _Zero:
    """MatchSettings falso: todas las consultas devuelven 0 (modo Soccer, mutadores por defecto)."""
    def __getattr__(self, k):
        if k.startswith('__'): raise AttributeError(k)
        return lambda *a, **kw: _Zero() if k.endswith('Settings') else 0
class _MatchSettings(_Zero): pass
