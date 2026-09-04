import { getAuthService } from "@/lib/bergbok/auth";
import { loginResponse } from "@/lib/bergbok/auth-http";
import { assertSameOrigin, errorResponse, jsonBody } from "@/lib/bergbok/http";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await jsonBody(request);
    const session = await getAuthService().loginPassword(body.email, body.password);
    return loginResponse(session);
  } catch (error) {
    return errorResponse(error);
  }
}
