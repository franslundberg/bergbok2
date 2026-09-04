import { getAuthService } from "@/lib/bergbok/auth";
import { challengeStartedResponse } from "@/lib/bergbok/auth-http";
import { assertSameOrigin, errorResponse, jsonBody, remoteAddress } from "@/lib/bergbok/http";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await jsonBody(request);
    const result = await getAuthService().startCode(body.email, remoteAddress(request));
    return challengeStartedResponse(result.challengeToken);
  } catch (error) {
    return errorResponse(error);
  }
}
