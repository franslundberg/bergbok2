export type ChatMessageLike = {
  role: string;
  parts?: readonly { type: string; text?: string }[];
  content?: readonly { type: string; text?: string }[];
};

const messageText = (message: ChatMessageLike) =>
  (message.parts ?? message.content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");

const EMAIL_PATTERN = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/i;

export const emailAddressInText = (text: string) => text.match(EMAIL_PATTERN)?.[0]?.toLowerCase();

export const latestEmailAddress = (messages: readonly ChatMessageLike[]) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const email = emailAddressInText(messageText(message));
    if (email) return email;
  }
  return undefined;
};

export const containsCredentialLikeInput = (messages: readonly ChatMessageLike[]) => {
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  if (!lastUser) return false;
  const text = messageText(lastUser).trim();
  return /^\d{6}$/.test(text) || /^(?:lösenord|password)\s*[:=]/i.test(text);
};
