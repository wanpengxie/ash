export interface ScreenPresenceView {
  list(): { id: string; name: string; online: boolean }[];
  visible(screen: string): boolean;
}

/** One line for the agent's turn context: which of the owner's screens is in front of them right now. */
export function ownerScreensLine(screens: ScreenPresenceView): string {
  const names = screens.list().filter((screen) => screen.online && screens.visible(screen.id)).map((screen) => screen.name.replace(/[\p{C}\s]+/gu, " ").trim().slice(0, 40) || "a screen");
  return `Owner is looking at: ${names.length ? [...new Set(names)].join(", ") : "no screen right now (the phone is locked or Ash is in the background)"}`;
}
