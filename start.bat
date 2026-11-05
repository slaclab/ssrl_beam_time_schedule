@echo off
rem Start the SSRL Beam Time calendar and open it in the default browser.
cd /d "%~dp0"
start "" http://localhost:8000/
python server.py %*
