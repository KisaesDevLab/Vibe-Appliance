// Email through the firm's own provider, as configured in the appliance's
// Configuration → Email (EMAIL_PROVIDER in appliance.env). On a standby the
// settings come from its own tree if set, otherwise from the mirror of the
// primary's settings, so a standby can raise the alarm without extra setup.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readEnvFile } from "../appliance/consoleClient.ts";
import { redactor } from "../logger.ts";

export interface Mailer { send(to: string, subject: string, text: string): Promise<void>; readonly describe: string }

async function emailEnv(trees: string[]): Promise<Record<string, string> | null> {
  for (const tree of trees) {
    const env: Record<string, string> = {};
    for (const f of ["shared.env", "appliance.env"]) {
      const p = join(tree, "env", f);
      if (existsSync(p)) Object.assign(env, await readEnvFile(p).catch(() => ({})));
    }
    if (env.EMAIL_PROVIDER && env.EMAIL_FROM) return env;
  }
  return null;
}

async function post(url: string, headers: Record<string, string>, body: unknown, f: typeof fetch): Promise<void> {
  const r = await f(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`the email provider answered ${r.status}: ${redactor.text((await r.text()).slice(0, 200))}`);
}

/** Build a mailer from the appliance's email settings; null when none are configured. */
export async function loadMailer(trees: string[], fetchImpl: typeof fetch = fetch): Promise<Mailer | null> {
  const env = await emailEnv(trees);
  if (!env) return null;
  const from = env.EMAIL_FROM!;
  const provider = env.EMAIL_PROVIDER!.toLowerCase();
  for (const k of ["RESEND_API_KEY", "POSTMARK_SERVER_TOKEN", "EMAILIT_API_KEY", "SMTP_PASSWORD"]) redactor.register(env[k]);
  if (provider === "resend" && env.RESEND_API_KEY) {
    return { describe: "Resend", send: (to, subject, text) => post("https://api.resend.com/emails", { authorization: `Bearer ${env.RESEND_API_KEY}` }, { from, to: [to], subject, text }, fetchImpl) };
  }
  if (provider === "postmark" && env.POSTMARK_SERVER_TOKEN) {
    return { describe: "Postmark", send: (to, subject, text) => post("https://api.postmarkapp.com/email", { accept: "application/json", "x-postmark-server-token": env.POSTMARK_SERVER_TOKEN! }, { From: from, To: to, Subject: subject, TextBody: text }, fetchImpl) };
  }
  if (provider === "emailit" && env.EMAILIT_API_KEY) {
    return { describe: "EmailIt", send: (to, subject, text) => post("https://api.emailit.com/v2/emails", { authorization: `Bearer ${env.EMAILIT_API_KEY}` }, { from, to, subject, text, html: `<p>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>")}</p>` }, fetchImpl) };
  }
  if (provider === "smtp" && env.SMTP_HOST) {
    const port = Number(env.SMTP_PORT || 587);
    return {
      describe: "SMTP",
      send: async (to, subject, text) => {
        const { createTransport } = await import("nodemailer");
        const t = createTransport({ host: env.SMTP_HOST, port, secure: port === 465, auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? "" } : undefined });
        await t.sendMail({ from, to, subject, text });
      },
    };
  }
  return null;
}
