module.exports = {
  apps: [{
    name: 'sentient-python',
    script: '/Users/julian_dev/.sentient-venv313/bin/uvicorn',
    args: 'main:app --port 8001 --host 0.0.0.0',
    cwd: '/Users/julian_dev/Documents/code/sentient app/python-service',
    interpreter: '/Users/julian_dev/.sentient-venv313/bin/python3',
    autorestart: true,
    max_restarts: 10,
    env: {
      PYTHONUNBUFFERED: '1',
    },
  }],
}
