import { requireOwner } from "@/lib/bergbok/auth-http";
import { artifactContent } from "@/lib/bergbok/application";
import { artifactBaseMediaType, isInlineArtifactMediaType } from "@/lib/bergbok/artifact-delivery";
import { errorResponse } from "@/lib/bergbok/http";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireOwner(request);
    const file = await artifactContent((await params).id);
    const inline = isInlineArtifactMediaType(file.mediaType);
    const html = artifactBaseMediaType(file.mediaType) === "text/html";
    return new Response(file.bytes, {
      headers: {
        "Content-Type": file.mediaType,
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        ...(html
          ? {
              "Content-Security-Policy":
                "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
            }
          : {}),
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
