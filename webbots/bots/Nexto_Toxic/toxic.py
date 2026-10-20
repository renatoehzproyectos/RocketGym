import os
import sys

# Nexto (Toxic!) = Nexto con isToxic=True. Reutiliza los ficheros de ../Nexto.
sys.path.append(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "Nexto"))
from bot import Nexto  # noqa: E402


class ToxicNexto(Nexto):
    def __init__(self, name, team, index):
        super().__init__(name, team, index)
        self.isToxic = True
