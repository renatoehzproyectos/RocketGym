#!/usr/bin/env python3
"""Genera audio/ (WAV para loops sin corte, MP3 para el resto) a partir del pack RocketLeague-Audio.
Uso: python tools/audio/build_audio.py /ruta/RocketLeague-Audio-main
Para cambiar un sonido, edita MAP (nombre del juego -> archivo del pack) y vuelve a ejecutar.
Requiere ffmpeg y numpy. Los loops llevan un crossfade (equal-power) horneado en la costura."""
import sys, os, json, subprocess, numpy as np, wave

SRC = sys.argv[1] if len(sys.argv) > 1 else 'RocketLeague-Audio-main'
OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'audio')
I = 'Uncategorized/SFX_Impacts/SFX_Impacts_%04d.ogg'
CM = 'Uncategorized/SFX_Car_Movements/SFX_Car_Movements_%04d.ogg'
# nombre: (archivo del pack, tipo, opciones)   tipo: loop = WAV mono con crossfade; shot = MP3
MAP = {
  # motor (3 capas de RPM; se mezclan y cambian de tono según la velocidad)
  'engine_idle':  ('Motors/SFX_Motor_OctaneMK2/SFX_Motor_OctaneMK2_0011.ogg', 'loop', dict(sr=32000, xf=0.12, rms=0.10)),
  'engine_mid':   ('Motors/SFX_Motor_OctaneMK2/SFX_Motor_OctaneMK2_0008.ogg', 'loop', dict(sr=32000, xf=0.12, rms=0.10)),
  'engine_high':  ('Motors/SFX_Motor_OctaneMK2/SFX_Motor_OctaneMK2_0003.ogg', 'loop', dict(sr=32000, xf=0.12, rms=0.10)),
  # boost
  'boost_loop':   ('Boosts/SFX_Boost_Standard/SFX_Boost_Standard_0003.ogg', 'loop', dict(sr=32000, xf=0.2, rms=0.16)),
  'boost_start':  ('Boosts/SFX_Boost_Standard/SFX_Boost_Standard_0002.ogg', 'shot', dict(ch=1, trim=1.0)),
  'boost_end':    ('Boosts/SFX_Boost_Standard/SFX_Boost_Standard_0001.ogg', 'shot', dict(ch=1)),
  'skid_loop':    ('Uncategorized/SFX_Car_Tires/SFX_Car_Tires_0001.ogg', 'loop', dict(sr=32000, xf=0.2, rms=0.12)),
  # golpes (por intensidad)
  'hit_soft_1': (I % 540, 'shot', dict(ch=1)), 'hit_soft_2': (I % 276, 'shot', dict(ch=1)),
  'hit_med_1':  (I % 54,  'shot', dict(ch=1)), 'hit_med_2':  (I % 165, 'shot', dict(ch=1)),
  'hit_hard_1': (I % 91,  'shot', dict(ch=1)), 'hit_hard_2': (I % 369, 'shot', dict(ch=1)), 'hit_hard_3': (I % 13, 'shot', dict(ch=1)),
  # auto
  'jump': (CM % 1,  'shot', dict(ch=1, trim=0.9)), 'flip': (CM % 15, 'shot', dict(ch=1, trim=1.0)), 'land': (CM % 22, 'shot', dict(ch=1, trim=1.2)),
  # partido
  'goal':        ('GoalExplosions/SFX_GoalExplosion_NewDefault/SFX_GoalExplosion_NewDefault_0001.ogg', 'shot', dict(ch=2)),
  'crowd_cheer': ('Crowds/SFX_BG_Crowd/SFX_BG_Crowd_0107.ogg', 'shot', dict(ch=2)),
  'crowd_loop':  ('Crowds/SFX_BG_Crowd/SFX_BG_Crowd_0011.ogg', 'loop', dict(sr=24000, xf=1.0, rms=0.07, mp3=True)),
  'cd_tick': ('UserInterface/SFX_UI_Countdown/SFX_UI_Countdown_0002.ogg', 'shot', dict(ch=1)),
  'cd_go':   ('UserInterface/SFX_UI_Countdown/SFX_UI_Countdown_0003.ogg', 'shot', dict(ch=2)),
  # interfaz
  'ui_hover':   ('UserInterface/SFX_UI_MainMenu/SFX_UI_MainMenu_0003.ogg', 'shot', dict(ch=1)),
  'ui_click':   ('UserInterface/SFX_UI_MainMenu/SFX_UI_MainMenu_0013.ogg', 'shot', dict(ch=1)),
  'ui_confirm': ('UserInterface/SFX_UI_MainMenu/SFX_UI_MainMenu_0022.ogg', 'shot', dict(ch=1)),
  'ui_good':    ('UserInterface/SFX_UI_StatEvents/SFX_UI_StatEvents_0004.ogg', 'shot', dict(ch=2)),
  'ui_bad':     ('UserInterface/SFX_UI_Training/SFX_UI_Training_0006.ogg', 'shot', dict(ch=1)),
}

def decode(path, sr, ch=1):
    p = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-ac', str(ch), '-ar', str(sr), '-f', 'f32le', '-'], capture_output=True, check=True)
    x = np.frombuffer(p.stdout, dtype=np.float32).copy()
    return x.reshape(-1, ch) if ch > 1 else x

def write_wav(path, x, sr):
    pcm = (np.clip(x, -1, 1) * 32767).astype('<i2')
    with wave.open(path, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes(pcm.tobytes())

def to_mp3(x, sr, ch, path, br):
    pcm = np.clip(x, -1, 1).astype('<f4')
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-f', 'f32le', '-ar', str(sr), '-ac', str(ch), '-i', '-', '-c:a', 'libmp3lame', '-b:a', br, path], input=pcm.tobytes(), check=True)

def make_loop(x, sr, xf_s, rms):
    n = len(x); xf = min(int(xf_s * sr), n // 3)
    t = np.linspace(0, np.pi / 2, xf)
    y = x[:n - xf].copy()
    y[:xf] = x[:xf] * np.sin(t) + x[n - xf:] * np.cos(t)      # costura equal-power: el final se funde con el inicio
    y -= y.mean()
    cur = np.sqrt((y ** 2).mean()) + 1e-9
    return y * min(rms / cur, 6.0)

os.makedirs(OUT, exist_ok=True)
manifest = {}
for name, (rel, kind, o) in MAP.items():
    src = os.path.join(SRC, rel)
    if kind == 'loop':
        sr = o['sr']; y = make_loop(decode(src, sr), sr, o['xf'], o['rms']); y = np.clip(y, -0.98, 0.98)
        if o.get('mp3'):
            to_mp3(y, sr, 1, os.path.join(OUT, name + '.mp3'), '64k'); ext = 'mp3'
        else:
            write_wav(os.path.join(OUT, name + '.wav'), y, sr); ext = 'wav'
        manifest[name] = dict(file=name + '.' + ext, loop=True, src=rel)
    else:
        ch = o.get('ch', 1); sr = 44100
        x = decode(src, sr, ch)
        if 'trim' in o: x = x[:int(o['trim'] * sr)]
        fade = min(int(0.03 * sr), len(x) // 4)
        if fade: x[-fade:] *= np.linspace(1, 0, fade).reshape((-1, 1) if ch > 1 else (-1,))   # fade-out corto: sin clic al cortar
        pk = float(np.abs(x).max()) + 1e-9
        if pk > 0.98 or pk < 0.5: x = x * (0.95 / pk)
        to_mp3(x, sr, ch, os.path.join(OUT, name + '.mp3'), '96k' if ch == 2 else '80k')
        manifest[name] = dict(file=name + '.mp3', loop=False, src=rel)
json.dump(manifest, open(os.path.join(OUT, 'manifest.json'), 'w'), indent=1)
tot = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT))
print(len(manifest), 'sonidos,', round(tot / 1e6, 2), 'MB')
