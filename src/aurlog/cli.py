import argparse
import os
import sys
import time

from . import KEY_ISSUER, batch, jwk, observe, sign


def emit(**values):
    target = os.environ.get("GITHUB_OUTPUT")
    if target:
        with open(target, "a") as fh:
            for key, val in values.items():
                fh.write(f"{key}={val}\n")


def cmd_observe(args):
    entries = observe.observe(args.state, args.out)
    print(f"observed {len(entries)} new heads")
    emit(has_entries="true" if entries else "false", count=len(entries))
    return 0


def cmd_commit(args):
    print("state committed" if observe.commit(args.state) else "nothing to commit")
    return 0


def cycle(args, profile):
    entries = observe.observe(args.state, args.out, profile=profile)
    if not entries:
        return
    bundles = os.path.join(args.state, "bundles")
    os.makedirs(bundles, exist_ok=True)
    bundle = os.path.join(bundles, f"{int(time.time())}.sigstore.json")
    stmt = os.path.join(args.out, "statement.json")
    sign.sign_with_key(stmt, args.key, bundle, args.offline)
    observe.commit(args.state)
    print(f"signed {len(entries)} entries -> {bundle}", flush=True)


def cmd_jwks(args):
    keys = jwk.publish(args.pub, args.issuer, args.out)
    print(f"wrote {len(keys)} key(s) kid={[k['kid'] for k in keys]} to {args.out}")
    return 0


def cmd_run(args):
    profile = batch.key_profile(jwk.from_pem(args.pub[0])["kid"])
    while True:
        try:
            cycle(args, profile)
        except Exception as err:
            print(f"cycle failed: {err}", file=sys.stderr, flush=True)
        if args.once:
            return 0
        time.sleep(args.interval)


def main(argv=None):
    parser = argparse.ArgumentParser(prog="aurlog")
    sub = parser.add_subparsers(dest="cmd", required=True)
    for name, fn in (("observe", cmd_observe), ("commit", cmd_commit), ("run", cmd_run), ("jwks", cmd_jwks)):
        p = sub.add_parser(name)
        p.add_argument("--state", default=".state")
        p.add_argument("--out", default="out")
        p.set_defaults(fn=fn)
        if name == "run":
            p.add_argument("--key", default=os.environ.get("AURLOG_KEY", "cosign.key"))
            p.add_argument("--pub", nargs=1, default=[os.environ.get("AURLOG_PUB", "cosign.pub")])
            p.add_argument("--interval", type=int, default=300)
            p.add_argument("--once", action="store_true")
            p.add_argument("--offline", action="store_true")
        if name == "jwks":
            p.add_argument("--pub", nargs="+", default=["cosign.pub"])
            p.add_argument("--issuer", default=KEY_ISSUER)
    args = parser.parse_args(argv)
    try:
        return args.fn(args)
    except Exception as err:
        print(f"::warning::{args.cmd} failed: {err}", file=sys.stderr)
        return 0 if args.cmd != "run" else 1
