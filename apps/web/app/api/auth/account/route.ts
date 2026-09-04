import { getAuthService } from "@/lib/bergbok/auth";
import { assertSameOrigin, errorResponse, jsonBody } from "@/lib/bergbok/http";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await jsonBody(request);
    return Response.json({ kind: getAuthService().accountKind(body.email) });
  } catch (error) {
    return errorResponse(error);
  }
}
