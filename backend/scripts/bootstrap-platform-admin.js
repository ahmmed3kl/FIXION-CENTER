const readline = require("readline");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const db = require("../src/db");

function ask(question, hidden = false) {
  if (process.env[hidden ? "PLATFORM_ADMIN_PASSWORD" : "PLATFORM_ADMIN_EMAIL"]) return Promise.resolve(process.env[hidden ? "PLATFORM_ADMIN_PASSWORD" : "PLATFORM_ADMIN_EMAIL"]);
  if (hidden && process.stdin.isTTY) return new Promise((resolve) => {
    process.stdout.write(question); process.stdin.setRawMode(true); process.stdin.resume(); let value = "";
    const onData = (chunk) => { const key = String(chunk); if (key === "\u0003") process.exit(130); if (key === "\r" || key === "\n") { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.removeListener("data", onData); process.stdout.write("\n"); resolve(value); } else if (key === "\u007f") value = value.slice(0, -1); else value += key; };
    process.stdin.on("data", onData);
  });
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); }));
}

async function main() {
  const email = String(await ask("Platform Admin email: ")).toLowerCase();
  const password = String(await ask("Platform Admin password: ", true));
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("A valid email is required.");
  if (password.length < 12 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) throw new Error("Password must be at least 12 characters and contain letters and numbers.");
  const existing = await db.query("SELECT id FROM platform_admins WHERE LOWER(email) = $1 OR status = 'active' LIMIT 1", [email]);
  if (existing.rows.length) throw new Error("An active Platform Admin already exists or this email is already registered.");
  const hash = await bcrypt.hash(password, 12);
  await db.query("INSERT INTO platform_admins (id, full_name, email, password_hash) VALUES ($1, $2, $3, $4)", [`platform-admin-${crypto.randomUUID()}`, email.split("@")[0], email, hash]);
  console.log("Platform Admin created successfully.");
}

main().catch((error) => { console.error(`Bootstrap failed: ${error.message}`); process.exitCode = 1; });
