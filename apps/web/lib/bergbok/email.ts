import nodemailer from "nodemailer";

export type SendPin = (email: string, pin: string) => Promise<void>;

export const sendPinEmail: SendPin = async (email, pin) => {
  const host = process.env.SMTP_HOST?.trim();
  const from = process.env.SMTP_FROM?.trim();
  if (!host || !from) throw new Error("SMTP_HOST eller SMTP_FROM saknas.");

  const transporter = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === "true",
    requireTLS: process.env.SMTP_SECURE !== "true",
    auth:
      process.env.SMTP_USER && process.env.SMTP_PASS
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
  });

  await transporter.sendMail({
    from,
    to: email,
    subject: "Din kod till Bergbok",
    text: `Din tillfälliga kod är ${pin}. Koden gäller i 10 minuter.`,
    html: `<p>Din tillfälliga kod är <strong>${pin}</strong>.</p><p>Koden gäller i 10 minuter.</p>`,
  });
};
