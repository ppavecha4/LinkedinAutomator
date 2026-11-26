# Setting up a new server (AWS Lightsail, Mumbai)

About an hour, most of it waiting. Only the web server (ports 80 and 443) is ever reachable from the
internet, plus remote login from your own address.

## 1. Secure the AWS account (once)

- Turn on two-factor sign-in (MFA) for the root account.
- Billing > Budgets: add a monthly budget alert (for example 50 USD).

## 2. Make a new login key (on your computer, PowerShell)

```powershell
ssh-keygen -t ed25519 -f "$env:USERPROFILE\.ssh\appson_lightsail"
```

Choose a passphrase. Upload the file ending in `.pub` in the next step. Never share the other one.

## 3. Create the server (Lightsail console)

1. **Create instance**: region **Mumbai (ap-south-1)**, **Linux/Unix**, **OS only**, **Ubuntu 24.04 LTS**.
2. **SSH key**: upload `appson_lightsail.pub`.
3. Plan: **4 GB memory, public IPv4**. Name it, then create.
4. **Snapshots** tab: turn on **automatic snapshots**.
5. **Networking** tab:
   - **Create a static IP** and attach it to the instance.
   - IPv4 firewall, exactly three rules: **HTTP (80)**, **HTTPS (443)**, and **SSH (22) restricted to
     your IP address**. Delete any other rule.
   - Turn **IPv6 networking off** (otherwise it has its own firewall to maintain).

If your home internet address changes, update the SSH rule in the console.

## 4. Point your domain at it

At your DNS provider, set the `A` record of your app's domain to the static IP. Do this before step 6,
so the HTTPS certificate can be issued.

## 5. Prepare the server

Connect (replace `STATIC_IP`):

```powershell
ssh -i "$env:USERPROFILE\.ssh\appson_lightsail" ubuntu@STATIC_IP
```

Then, on the server:

```bash
sudo git clone https://github.com/ppavecha4/LinkedinAutomator.git /opt/ai-sales-agent
cd /opt/ai-sales-agent
sudo bash scripts/server/setup.sh
sudo bash scripts/server/make_env.sh your.domain.com you@your.domain.com
sudo nano .env
```

`setup.sh` installs Docker, turns on automatic security updates, allows SSH with keys only and adds swap.
`make_env.sh` creates the settings file with new random passwords. In `nano`, paste **newly created**
provider keys (Anthropic, email, WhatsApp, ...). Save with `Ctrl+O`, `Enter`, then `Ctrl+X`.

## 6. First start

```bash
sudo bash scripts/server/first_start.sh
```

It asks you for a sign-in password, then prints the **backup private key**: save it in your password
manager, it is not kept on the server. When it says "Done", open your domain and sign in.

**Starting from an older database dump** (plain SQL, from `pg_dump`). Copy it to the server, then:

```bash
sudo bash scripts/server/first_start.sh --restore /home/ubuntu/dump.sql
```

All campaigns are **paused** after a restore, so nothing old is sent by itself. Before you resume any,
add everyone who asked you to stop since the dump was made to the suppression list: check your inbox and
WhatsApp replies. Delete the dump file from the server afterwards.

## 7. Check it

```bash
sudo bash scripts/server/check_ports.sh running
```

- **Backups**: set `BACKUP_S3_URL` and its keys in `.env` (a storage bucket outside this server), then
  `sudo docker compose -p ai-sales-agent -f docker-compose.prod.yml --profile edge up -d`.
  Without it the backups exist only on the server.
- **Alerts**: set `ALERT_EMAIL` (with the `PLATFORM_SMTP_*` mailbox) or `ALERT_WEBHOOK_URL`.
- **WhatsApp through Meta**: follow the slice 10.5 go-live list in `docs/saas-architecture.md`.

## Later releases

```bash
cd /opt/ai-sales-agent
sudo bash scripts/vps/deploy.sh
```

It backs up, pulls `main`, migrates, rebuilds, and refuses to continue if any port other than 80 or 443
would be exposed.

**Never start `docker-compose.yml` on a server.** It is for development only.
