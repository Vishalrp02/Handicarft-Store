# Dev VM setup (Oracle Cloud Always Free)

Your laptop only runs VS Code. Code, tests, Docker, Postgres and RabbitMQ run on a free Oracle Cloud ARM server.
Total time: about 45 minutes, most of it waiting. Cost: ₹0 (the free tier covers 4 ARM cores and 24 GB RAM in total; this VM uses half).

You need: a debit/credit card (Oracle verifies it with a small refundable charge), a phone number, and VS Code on the laptop.

---

## Part A: Create the Oracle Cloud account (one time)

1. Go to **https://www.oracle.com/cloud/free/** → **Start for free**.
2. Fill in your details. For **Home Region** choose **India West (Mumbai)** or **India South (Hyderabad)**.
   ⚠️ The home region **cannot be changed later**, and Always Free ARM servers only run in the home region.
3. Verify the card. The charge is reversed.
4. Wait for the "Your account is ready" email (minutes to a few hours), then sign in at **https://cloud.oracle.com**.
5. **Recommended: upgrade to Pay As You Go.** Menu ☰ → **Billing & Cost Management** → **Upgrade and Manage Payment** → Pay As You Go.
   Always Free resources stay **free**. The upgrade stops Oracle from reclaiming "idle" free servers, and makes ARM capacity much easier to get.
6. Protect yourself from surprise bills: ☰ → **Billing & Cost Management** → **Budgets** → **Create Budget**, amount **₹100**, alert at **1 %** to your email.

## Part B (fast way): create everything with one script

Instead of clicking through Part B below, you can let [`create-dev-vm.sh`](create-dev-vm.sh) create the network and the VM.

1. **Make an SSH key on your laptop** (PowerShell; press Enter twice for no passphrase, or set one):
   ```powershell
   mkdir $HOME\.ssh -Force
   ssh-keygen -t ed25519 -f $HOME\.ssh\craftoria-dev -C craftoria-dev
   Get-Content $HOME\.ssh\craftoria-dev.pub
   ```
   Copy the single line it prints (it starts with `ssh-ed25519`). That's the **public** key and is safe to share. Never copy the file without `.pub`.
2. In the Oracle console, open **Cloud Shell**: the `>_` icon at the top right. A terminal opens in the browser, already logged in.
3. Upload two files from this repo with Cloud Shell's **gear menu → Upload**: `infra/oracle/create-dev-vm.sh` and `infra/oracle/cloud-init.dev.yaml`. They land in your Cloud Shell home folder.
4. Run, pasting your public key between the quotes:
   ```bash
   export SSH_PUBLIC_KEY="ssh-ed25519 AAAA...your key... craftoria-dev"
   DRY_RUN=1 bash create-dev-vm.sh     # optional: shows the plan, creates nothing
   bash create-dev-vm.sh
   ```
   It takes 2–5 minutes. If ARM capacity is busy, it tries every availability domain and then retries every 10 minutes for up to 2 hours. You can close the tab and rerun later; that's safe. It refuses to create anything beyond the Always Free limit.
5. At the end it prints the **public IP** and the exact block for your `~\.ssh\config`. Add it, then go to **Part C step 3** (the key is already in the right place, so skip Part C steps 1–2).

## Part B: Create the VM (manual, in the console)

1. ☰ → **Compute** → **Instances** → **Create instance**.
2. **Name:** `craftoria-dev`.
3. **Image and shape** → **Edit**:
   - **Change shape** → **Ampere** → **VM.Standard.A1.Flex** → **2 OCPUs**, **12 GB memory**.
   - **Change image** → **Canonical Ubuntu** → **24.04** (it shows "aarch64"/ARM automatically for Ampere).
4. **Networking:** keep **Create new virtual cloud network** and **Assign a public IPv4 address** = Yes.
5. **Add SSH keys:** choose **Generate a key pair for me** → **Save private key**. This downloads a file like `ssh-key-2026-10-08.key`. **Keep it safe; it's the only way in.**
6. **Boot volume:** tick **Specify a custom boot volume size** → **100 GB**.
7. **Show advanced options** → **Management** → **Paste cloud-init script** → paste the **entire contents** of [`infra/oracle/cloud-init.dev.yaml`](cloud-init.dev.yaml).
8. **Create**. Wait until the state is **Running** (1–3 min). Copy the **Public IP address** from the instance page.

> **"Out of capacity for shape VM.Standard.A1.Flex"?** That's common and not your fault. Try another **Availability Domain** in step 3 (if your region shows several), try again in a few hours, or start with **1 OCPU / 6 GB** and resize later (Instance → **Edit** → shape). The Pay As You Go upgrade (A5) helps a lot.

## Part C: Connect from Windows (PowerShell)

1. Make the key private. Windows SSH refuses keys other users can read. Open **PowerShell** and run, using your file name:
   ```powershell
   mkdir $HOME\.ssh -Force
   Move-Item "$HOME\Downloads\ssh-key-2026-10-08.key" "$HOME\.ssh\craftoria-dev.key"
   icacls "$HOME\.ssh\craftoria-dev.key" /inheritance:r /grant:r "$($env:USERNAME):(R)"
   ```
2. Add a shortcut so you can type `ssh craftoria-dev`. Open `$HOME\.ssh\config` in Notepad (create it if missing) and add, with **your** IP:
   ```
   Host craftoria-dev
       HostName 140.238.XX.XX
       User ubuntu
       IdentityFile ~/.ssh/craftoria-dev.key
       ServerAliveInterval 30
   ```
3. Connect: `ssh craftoria-dev` → answer **yes** to the fingerprint question.
4. Wait for the setup script to finish (5–10 min on first boot):
   ```bash
   cloud-init status --wait
   ```
   It should end with `status: done`. Then type `exit` and run `ssh craftoria-dev` again, so the Docker permission applies.

## Part D: VS Code on the VM

1. In VS Code on the laptop, install the extension **Remote - SSH** (by Microsoft).
2. Press **F1** → **Remote-SSH: Connect to Host…** → **craftoria-dev**. A new window opens; the bottom-left corner shows `SSH: craftoria-dev`.
3. VS Code installs a small server on the VM the first time (about 1 min).

## Part E: Get the project onto the VM

In the VS Code **terminal** (which is now the VM's terminal):

```bash
cd ~/code
git clone https://github.com/Vishalrp02/Handicarft-Store.git
cd Handicarft-Store
git checkout docs/dev-vm-setup     # the latest work branch (contains all earlier tasks)
pnpm install
bash infra/oracle/verify-dev-vm.sh # every line must say PASS
pnpm lint && pnpm typecheck && pnpm test
```

Then **File → Open Folder… → `/home/ubuntu/code/Handicarft-Store`**.

Set your git identity on the VM once (the same as on the laptop):

```bash
git config --global user.name "Vishal"
git config --global user.email "vishalrajpurohit02@gmail.com"
```

## Part F: Claude Code on the VM

1. In the VM window, open the Extensions panel and install **Claude Code** there. VS Code shows an "Install in SSH: craftoria-dev" button.
2. Sign in when asked.
3. Start the first message with: **"Read docs/PROGRESS.md and continue from where we stopped."** Everything the new session needs is in the repo: rules in `CLAUDE.md`, the spec in `docs/architecture/`, the plans, and the current state in `docs/PROGRESS.md`.

---

## Troubleshooting

| Problem                                        | Fix                                                                                                                                                       |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Permission denied (publickey)`                | Wrong key path in `~/.ssh/config`, or user isn't `ubuntu`. Check both.                                                                                    |
| `UNPROTECTED PRIVATE KEY FILE`                 | Rerun the `icacls` line in Part C step 1.                                                                                                                 |
| SSH hangs or times out                         | Instance not Running, wrong IP, or the subnet's security list lost the port 22 rule (Networking → VCN → Security Lists → Ingress: TCP 22 from 0.0.0.0/0). |
| `permission denied ... docker.sock`            | Log out and back in (Part C step 4).                                                                                                                      |
| `verify-dev-vm.sh` fails "cloud-init finished" | Wait: `cloud-init status --wait`. If it says `error`, run `sudo cat /var/log/cloud-init-output.log                                                        | tail -50` and send me the output. |
| VS Code server install fails                   | F1 → **Remote-SSH: Kill VS Code Server on Host** → connect again.                                                                                         |

## Security notes

- Only SSH key login is possible (Ubuntu on Oracle disables passwords). Never share the `.key` file or commit it.
- Port 22 is open to the internet, which is normal for SSH with keys. Plan 14 later moves SSH behind **Tailscale** and closes port 22 completely.
- The VM is a development machine. Real customer data and production secrets go only on the production VM (Plan 14).
