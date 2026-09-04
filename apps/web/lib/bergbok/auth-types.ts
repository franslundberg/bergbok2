export type PublicAuthState =
  | { stage: "signed_out" }
  | { stage: "code"; emailHint: string }
  | { stage: "set_password"; emailHint: string }
  | {
      stage: "authenticated";
      email: string;
      company: { id: "fiktiv-ab"; name: "Fiktiv AB"; role: "owner"; canApprove: true };
    };

export type AuthenticatedSession = {
  sessionId: string;
  userId: string;
  email: string;
  expiresAt: number;
};
