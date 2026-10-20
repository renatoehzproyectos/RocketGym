class _Meta(type):
    def __getattr__(cls, k):
        if k.startswith('__'): raise AttributeError(k)
        return 0

class _Any(metaclass=_Meta):
    """Clase comodín: acepta cualquier construcción/atributo (cosas de RLBot que no hacen falta en el navegador)."""
    def __init__(self, *a, **k): pass
    def __getattr__(self, k):
        if k.startswith('__'): raise AttributeError(k)
        return _Any()
    def __call__(self, *a, **k): return _Any()
def install_getattr(g):
    def __getattr__(name):
        if name.startswith('__'): raise AttributeError(name)
        return _Meta(name, (_Any,), {})
    g['__getattr__'] = __getattr__
