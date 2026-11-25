import subprocess


def sign_with_key(statement, key, bundle, offline=False):
    cmd = ["cosign", "attest-blob", "--yes", "--key", key, "--statement", statement, "--bundle", bundle]
    if offline:
        cmd += ["--use-signing-config=false", "--tlog-upload=false"]
    cmd.append(statement)
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip()[-500:])
