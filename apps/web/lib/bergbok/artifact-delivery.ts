const INLINE_ARTIFACT_MEDIA_TYPES = new Set(["text/html", "application/pdf"]);

export const artifactBaseMediaType = (mediaType: string) =>
  mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";

export const isInlineArtifactMediaType = (mediaType: string) =>
  INLINE_ARTIFACT_MEDIA_TYPES.has(artifactBaseMediaType(mediaType));
