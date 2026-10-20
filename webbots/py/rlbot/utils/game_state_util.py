class _Part:
    def __init__(self, *a, **k):
        for i, v in enumerate(a): setattr(self, 'arg%d' % i, v)
        self.__dict__.update(k)
class Vector3(_Part):
    def __init__(self, x=None, y=None, z=None): self.x, self.y, self.z = x, y, z
class Rotator(_Part):
    def __init__(self, pitch=None, yaw=None, roll=None): self.pitch, self.yaw, self.roll = pitch, yaw, roll
class Physics(_Part):
    def __init__(self, location=None, rotation=None, velocity=None, angular_velocity=None):
        self.location, self.rotation, self.velocity, self.angular_velocity = location, rotation, velocity, angular_velocity
class BallState(_Part):
    def __init__(self, physics=None): self.physics = physics
class CarState(_Part):
    def __init__(self, physics=None, jumped=None, double_jumped=None, boost_amount=None): self.physics = physics; self.boost_amount = boost_amount
class BoostState(_Part): pass
class GameInfoState(_Part): pass
class GameState(_Part):
    def __init__(self, ball=None, cars=None, boosts=None, game_info=None, console_commands=None): self.ball = ball; self.cars = cars
    def convert_to_flat(self, builder=None): return 0
