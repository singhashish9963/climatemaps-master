# Deployment Instructions for Render

1. Make sure your root directory is set to `climatemaps-master/climatemaps-master` in Render settings.
2. Python version is specified in `runtime.txt` and `render.yaml`.
3. Build command: `pip install -r requirements.txt`
4. Start command: `uvicorn api.main:app --host=0.0.0.0 --port=8000`

If you use Docker or Poetry, update those files accordingly.
