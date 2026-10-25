#!/usr/bin/env python3
"""Explicit setup of isolated Python dependencies; no credentials or global pip."""
import argparse,json,os,subprocess,sys,venv
from pathlib import Path
from runtime_paths import state_root,runtime_python

def main():
    argparse.ArgumentParser(description=__doc__).parse_args()
    if sys.version_info<(3,10):raise SystemExit('Python 3.10+ is required.')
    root=state_root()
    if root.is_symlink():raise SystemExit('Application state directory must not be a symbolic link.')
    root.mkdir(parents=True,exist_ok=True,mode=0o700)
    if os.name!='nt':root.chmod(0o700)
    python=runtime_python()
    if not python.exists():venv.EnvBuilder(with_pip=True).create(root/'runtime')
    subprocess.run([str(python),'-m','pip','install','--disable-pip-version-check','-r',str(Path(__file__).resolve().parents[1]/'requirements.txt')],check=True,stdout=sys.stderr)
    print(json.dumps({'ok':True,'runtime':str(python),'credential_store':'operating-system','obsidian_required':False}))
if __name__=='__main__':main()
