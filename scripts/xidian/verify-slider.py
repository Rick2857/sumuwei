"""Synthetic local images only: verify the shipped matcher, not a real school challenge."""
import base64
import io
import json
from pathlib import Path
import random
import subprocess
import sys
from PIL import Image

rng = random.Random(1618)
background = Image.new('RGBA', (280, 120))
background.putdata([(rng.randrange(256), rng.randrange(256), rng.randrange(256), 255) for _ in range(280 * 120)])
piece = background.crop((37, 0, 133, 120))


def encode(image):
    buffer = io.BytesIO()
    image.save(buffer, format='PNG')
    return base64.b64encode(buffer.getvalue()).decode('ascii')


script = Path(__file__).with_name('solve-slider.py')
result = subprocess.run([sys.executable, '-I', str(script)], input=json.dumps({'bigImage': encode(background), 'smallImage': encode(piece)}), text=True, capture_output=True, timeout=15)
assert result.returncode == 0 and json.loads(result.stdout) == {'offset': 37}, (result.returncode, result.stdout)
invalid = subprocess.run([sys.executable, '-I', str(script)], input='{"bigImage":"invalid","smallImage":"invalid"}', text=True, capture_output=True, timeout=15)
assert invalid.returncode == 1 and json.loads(invalid.stdout) == {'error': 'captcha_match_failed'}
print('PASS local slider matcher: known synthetic offset and malformed image rejection (2 checks; zero network)')
