/** The two participants. */
export type Participant = "a" | "b";

/** Every other day, per the approved design. Configurable because the spec
 * flags background churn as the thing most likely to need slowing down. */
export const DEFAULT_PHOTO_CADENCE_DAYS = 2;

export interface PhotoDayInput {
  /** Whole days elapsed since the schedule anchor. Day 0 is the anchor and is
   * itself a photo day. Callers compute this from dates; this module never
   * reads a clock. */
  dayIndex: number;
  /** Days between photo days. 1 means every day, 2 means every other day. */
  cadenceDays?: number; // defaults to DEFAULT_PHOTO_CADENCE_DAYS
}

/** Whether the given day is a photo day. Pure arithmetic, no clock reads,
 * so the caller owns turning a real date into dayIndex. */
export function isPhotoDay(input: PhotoDayInput): boolean {
  const { dayIndex } = input;
  const cadenceDays = input.cadenceDays ?? DEFAULT_PHOTO_CADENCE_DAYS;

  if (!Number.isInteger(dayIndex)) {
    throw new Error(`dayIndex must be an integer, got ${dayIndex}`);
  }
  if (!Number.isInteger(cadenceDays) || cadenceDays <= 0) {
    throw new Error(`cadenceDays must be a positive integer, got ${cadenceDays}`);
  }
  // Days before the anchor are not schedule days at all, not merely
  // off-cadence, so they are excluded outright rather than modded.
  if (dayIndex < 0) return false;

  return dayIndex % cadenceDays === 0;
}

/** Whose turn a given photo day belongs to. Photo days are 1-based: the first
 * photo day is number 1. Even is "a", odd is "b", straight from the spec's
 * "Whose photo becomes the background" section. */
export function turnHolder(photoDayNumber: number): Participant {
  if (!Number.isInteger(photoDayNumber) || photoDayNumber < 1) {
    throw new Error(`photoDayNumber must be an integer >= 1, got ${photoDayNumber}`);
  }
  return photoDayNumber % 2 === 0 ? "a" : "b";
}

export interface BackgroundInput<TPhoto> {
  /** 1-based ordinal of this photo day. Caller-held state, because the counter
   * deliberately does not advance on days nobody sent a photo. */
  photoDayNumber: number;
  aPhoto: TPhoto | null;
  bPhoto: TPhoto | null;
}

export type BackgroundDecision<TPhoto> =
  | {
      changeBackground: true;
      /** Whose photo won, which is not always the turn holder. */
      from: Participant;
      photo: TPhoto;
      /** Turn was actually used, so the next photo day is the next ordinal. */
      nextPhotoDayNumber: number;
    }
  | {
      changeBackground: false;
      from: null;
      photo: null;
      /** Unchanged, so the turn holder keeps their turn. */
      nextPhotoDayNumber: number;
    };

/** Decides whose photo becomes the shared background, and whether the turn
 * counter advances. "A turn is a preference, not a veto": the turn holder's
 * photo wins when present, but a photo from the other person still gets
 * used and still consumes the turn. Only a day where neither person sent
 * anything leaves the counter untouched, so nobody loses their turn to a
 * day both people missed. */
export function resolveBackground<TPhoto>(
  input: BackgroundInput<TPhoto>,
): BackgroundDecision<TPhoto> {
  const { photoDayNumber, aPhoto, bPhoto } = input;
  const holder = turnHolder(photoDayNumber);
  const holderPhoto = holder === "a" ? aPhoto : bPhoto;
  const otherPhoto = holder === "a" ? bPhoto : aPhoto;
  const other: Participant = holder === "a" ? "b" : "a";

  if (holderPhoto !== null) {
    return {
      changeBackground: true,
      from: holder,
      photo: holderPhoto,
      nextPhotoDayNumber: photoDayNumber + 1,
    };
  }
  if (otherPhoto !== null) {
    return {
      changeBackground: true,
      from: other,
      photo: otherPhoto,
      nextPhotoDayNumber: photoDayNumber + 1,
    };
  }
  // Neither sent a photo: freeze the counter so the same holder gets
  // another shot next time, rather than silently forfeiting their turn.
  return {
    changeBackground: false,
    from: null,
    photo: null,
    nextPhotoDayNumber: photoDayNumber,
  };
}
