export const formatElapsed = (elapsedSeconds: number) => {
  const seconds = Math.max(0, Math.floor(elapsedSeconds));
  if (seconds < 10) return "Startar…";
  if (seconds < 60) return `${Math.floor(seconds / 10) * 10} sekunder`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} ${minutes === 1 ? "minut" : "minuter"}`;
};
