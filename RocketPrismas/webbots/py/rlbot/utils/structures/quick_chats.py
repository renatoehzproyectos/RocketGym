from rlbot._stub import install_getattr
install_getattr(globals())


class _QMeta(type):
    def __getattr__(cls, k):
        if k.startswith("__"):
            raise AttributeError(k)
        return k


class QuickChats(metaclass=_QMeta):
    """QuickChats.Reactions_Wow -> "Reactions_Wow" (el navegador lo muestra como mensaje)."""
