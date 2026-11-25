"""The VPS cron jobs, as a loop, for running the whole system on one computer.

On the VPS, cron runs scripts/vps/*.sh every few minutes. This does the same
inside a container (docker-compose.local.yml, service `scheduler`):

  every SCHEDULER_TICK_SECONDS (60), for each ACTIVE campaign:
      schedule_followups.py      queue the follow-ups that are due
      send_pending_emails.py     send queued email (the company's own mailbox)
      send_pending_whatsapp.py   send queued WhatsApp (customers only)
  every 5th tick:
      poll_email_replies.py      read replies and opt-outs from mailboxes
      process_inbound_events.py  webhook events (WhatsApp replies ...)

and reports a heartbeat after each group (V31 ops_heartbeat), so Platform ›
System health shows the same checks it would in production.

The scripts are run exactly as cron runs them (as subprocesses, with the app's
own non-superuser DATABASE_URL, so each works inside its company's tenant).
Only the LIST of campaigns is read with an admin connection (like the cron
scripts' `psql -U agent`), because the app role, by design, cannot see across
companies.
"""
from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys
from pathlib import Path

import asyncpg

log = logging.getLogger("local_scheduler")
SCRIPTS = Path(__file__).resolve().parent / "scripts"
TICK = int(os.environ.get("SCHEDULER_TICK_SECONDS", "60"))
SCRIPT_TIMEOUT = int(os.environ.get("SCHEDULER_SCRIPT_TIMEOUT", "280"))


async def run_script(name: str, *args: str) -> None:
    """Run one orchestrator script; log its last lines. Never raises."""
    proc = await asyncio.create_subprocess_exec(
        sys.executable, "-u", str(SCRIPTS / name), *args,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), SCRIPT_TIMEOUT)
    except asyncio.TimeoutError:
        proc.kill()
        log.warning("%s %s timed out after %ss", name, " ".join(args), SCRIPT_TIMEOUT)
        return
    tail = [ln for ln in out.decode("utf-8", "replace").splitlines() if ln.strip()][-3:]
    level = logging.INFO if proc.returncode == 0 else logging.WARNING
    for ln in tail:
        log.log(level, "%s: %s", name, ln)
    if proc.returncode != 0:
        log.warning("%s exited with %s", name, proc.returncode)


async def beat(conn: asyncpg.Connection, name: str) -> None:
    try:
        await conn.execute("SELECT ops_heartbeat($1)", name)
    except Exception as e:                      # the function arrives with V31; never fail the loop for it
        log.debug("heartbeat %s skipped: %s", name, e)


async def tick(n: int, conn: asyncpg.Connection) -> None:
    ids = [r["id"] for r in await conn.fetch("SELECT id::text AS id FROM campaigns WHERE status = 'ACTIVE' ORDER BY created_at")]
    log.info("tick %s: %s active campaign%s", n, len(ids), "" if len(ids) == 1 else "s")
    await beat(conn, "auto_sends")              # the sender loop ran, even with nothing to send
    for cid in ids:
        await run_script("schedule_followups.py", cid)
        await run_script("send_pending_emails.py", cid)
        await run_script("send_pending_whatsapp.py", cid, "--customers-only")
    if n % 5 == 0:
        await run_script("poll_email_replies.py")
        await beat(conn, "poll_replies")
        await run_script("process_inbound_events.py")
        await beat(conn, "proc_inbound")


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    dsn = os.environ.get("SCHEDULER_ADMIN_DATABASE_URL") or os.environ["DATABASE_URL"]
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:
            pass
    conn = await asyncpg.connect(dsn)
    log.info("scheduler up: every %ss", TICK)
    n = 0
    try:
        while not stop.is_set():
            try:
                await tick(n, conn)
            except Exception:
                log.exception("tick failed")
            n += 1
            try:
                await asyncio.wait_for(stop.wait(), TICK)
            except asyncio.TimeoutError:
                pass
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
