import { getAuthService, CHALLENGE_COOKIE } from "@/lib/bergbok/auth";
import { loginResponse, signupPendingResponse } from "@/lib/bergbok/auth-http";
import { assertSameOrigin, errorResponse, jsonBody, parseCookies } from "@/lib/bergbok/http";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await jsonBody(request);
    const result = await getAuthService().verifyCode(
      parseCookies(request).get(CHALLENGE_COOKIE),
      body.code,
    );
    return result.kind === "authenticated"
      ? loginResponse(result.session)
      : signupPendingResponse(result.signupToken);
  } catch (error) {
    return errorResponse(error);
  }
}
