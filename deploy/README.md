# Running Cloud9 on a VPS

This sets up Cloud9 for one user on an Ubuntu 24.04 or 26.04 server, behind
Apache with Let's Encrypt certificates:

    https://ide.example.com  -> Apache (TLS) -> Cloud9 on 127.0.0.1:8181
    https://app.example.com  -> Apache (TLS + login) -> your app on 127.0.0.1:8080

Cloud9 only listens on 127.0.0.1 and checks the login itself. The second
hostname is for "Preview Running Application"; leave it out if you don't
need it.

Replace `ide.example.com`, `app.example.com`, `dev` (your Linux user) and
`username` below with your own values.

## 1. Packages

Point DNS records for both hostnames at the server, then:

    sudo apt-get update
    sudo apt-get install -y git tmux python3 python3-venv build-essential \
        apache2 certbot python3-certbot-apache

Cloud9 needs Node.js 16 or newer; use 24 LTS (16 to 20 no longer get
security fixes). If `apt-cache policy nodejs` doesn't offer it, use
NodeSource:

    curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
    sudo apt-get install -y nodejs

## 2. Cloud9

As your own user (not root):

    git clone https://github.com/Jook3r/core.git ~/c9
    cd ~/c9
    scripts/install-sdk.sh
    mkdir -p ~/workspace

`install-sdk.sh` installs the npm modules, builds node-pty (the terminal)
and the packed client, and tells you if a system package is missing.

## 3. Login

    sudo install -d -m 755 /etc/cloud9
    sudo install -m 600 deploy/cloud9.env.example /etc/cloud9/cloud9.env
    sudo nano /etc/cloud9/cloud9.env

Set `C9_AUTH=username:password` (use a long random password) and
`C9_HOSTNAME=app.example.com`. Cloud9 refuses to start without a login.

An address that tries 10 different wrong passwords within 15 minutes is
refused for 15 minutes (HTTP 429), whatever it sends. Wrong passwords,
blocks and the first login from each address each day are logged:

    journalctl -u cloud9 | grep Login:

Behind Apache the address is the visitor's (Apache adds it to
`X-Forwarded-For`). With another reverse proxy on the same machine, make it
set that header too (nginx: `proxy_set_header X-Forwarded-For
$proxy_add_x_forwarded_for;`), or every visitor counts as the proxy.

## 4. Service

    sudo cp deploy/cloud9.service /etc/systemd/system/
    sudo nano /etc/systemd/system/cloud9.service   # User, Group, paths, node path (`which node`)
    sudo systemctl daemon-reload
    sudo systemctl enable --now cloud9
    curl -s -o /dev/null -w '%{http_code}\n' -u username:password http://127.0.0.1:8181/ide.html   # 200

Restarting the service keeps the terminals and everything running in them
(`KillMode=process`); reload the browser tab afterwards.

## 5. Certificates and Apache

    sudo certbot certonly --apache -d ide.example.com
    sudo certbot certonly --apache -d app.example.com

    sudo a2enmod proxy proxy_http headers ssl
    sudo cp deploy/apache2/cloud9-ide.conf deploy/apache2/cloud9-app.conf /etc/apache2/sites-available/
    sudo sed -i 's/ide\.example\.com/ide.yourdomain.com/g; s/app\.example\.com/app.yourdomain.com/g' \
        /etc/apache2/sites-available/cloud9-ide.conf /etc/apache2/sites-available/cloud9-app.conf
    sudo htpasswd -B -c /etc/apache2/cloud9-app.htpasswd username   # same login as the IDE
    sudo a2ensite cloud9-ide cloud9-app
    sudo apachectl configtest && sudo systemctl reload apache2

Apache 2.4.47 and newer proxy the IDE's websocket with `upgrade=websocket`;
`mod_proxy_wstunnel` is not needed. The IDE has to be at the root of its
hostname (it can't live under a sub-path).

Firewall: only SSH, 80 and 443 need to be reachable.

    sudo ufw allow OpenSSH
    sudo ufw allow 'Apache Full'
    sudo ufw enable

## Your app

Run your app on `$IP:$PORT` (127.0.0.1:8080), as the Cloud9 runners do.
"Preview > Preview Running Application" opens https://app.example.com; the
browser asks for the app login once.

## Updating

    cd ~/c9
    git pull
    scripts/install-sdk.sh
    sudo systemctl restart cloud9

`--packed` serves a prebuilt, minified copy of the IDE's client code. If you
change the client code, rebuild it with `scripts/makestandalone.sh --compress`
(part of `install-sdk.sh`), or start the server without `--packed` while
working on it.

## Memory

About 75-100 MB for the server, plus about 55 MB per open IDE tab, plus the
Python tools (pylint, jedi) while they run and whatever you start from the
terminals.

## Troubleshooting

- `journalctl -u cloud9 -f` shows the server log.
- "Cloud9 needs a username and password": C9_AUTH is missing from
  /etc/cloud9/cloud9.env.
- 503 on ide.example.com: the service isn't running. 503 on app.example.com:
  nothing is listening on 127.0.0.1:8080.
- 403 "Cross-origin request refused": the browser's Origin doesn't match the
  hostname Apache forwards; check `ProxyPreserveHost On`.
