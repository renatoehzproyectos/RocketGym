import sys, types
from rlbot._stub import _Meta, _Any

class _FlatFinder:
    """rlbot.messages.flat.<Submodulo> -> módulo comodín (los flatbuffers no se usan en el navegador)."""
    def find_spec(self, name, path=None, target=None):
        if name.startswith('rlbot.messages.flat.'):
            import importlib.machinery
            return importlib.machinery.ModuleSpec(name, self)
    def create_module(self, spec):
        m = types.ModuleType(spec.name)
        short = spec.name.rsplit('.', 1)[1]
        cls = _Meta(short, (_Any,), {})
        setattr(m, short, cls)
        m.__getattr__ = lambda n: (_ for _ in ()).throw(AttributeError(n)) if n.startswith('__') else _Meta(n, (_Any,), {})
        return m
    def exec_module(self, module): pass
sys.meta_path.insert(0, _FlatFinder())
