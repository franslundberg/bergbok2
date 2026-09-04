import { NextResponse } from "next/server";
import { requireApprover } from "@/lib/bergbok/auth-http";
import { decideRun } from "@/lib/bergbok/application";
import { assertSameOrigin, errorResponse, jsonBody } from "@/lib/bergbok/http";
import { parseRunDecision } from "@/lib/bergbok/types";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const session = requireApprover(request);
    const body = parseRunDecision(await jsonBody(request));
    return NextResponse.json(
      await decideRun(session, (await params).id, body.expectedRunSha256, body.decision),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
