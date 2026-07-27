/** All outbound message wording lives here, and only here. */

export function promptMessage(promptText: string): string {
  return `Today's question:\n\n${promptText}\n\n(Reply SKIP to sit this one out.)`;
}

export function waitingNotice(partnerName: string): string {
  return `Got it! Waiting on ${partnerName}. You'll see their answer as soon as it's in.`;
}

export function feedbackAsk(): string {
  return `Quick optional one: any thoughts on today's question, or ideas for future ones? Anything you send me until tomorrow's question is noted.`;
}

/** Carries the partner's question as well as their answer: since the two
 * people are now asked different questions, an answer alone would arrive
 * with no idea what it was responding to. */
export function shareMessage(partnerName: string, questionText: string, responseText: string): string {
  return `${partnerName} was asked:\n${questionText}\n\nThey said:\n\n${responseText}`;
}

export function skipNotice(partnerName: string): string {
  return `${partnerName} skipped today's question. Back tomorrow!`;
}

export function skipAck(): string {
  return `No problem, skipping today. See you tomorrow!`;
}

export function oobReply(): string {
  return `I only do one daily question for now — I'll text you at prompt time!`;
}

export function nudgeNoResponse(): string {
  return `No rush, but today's question is still open whenever you get a chance!`;
}

export function nudgePartnerWaiting(partnerName: string): string {
  return `Friendly nudge: ${partnerName} already answered today's question, and it's waiting for you whenever you're free!`;
}

export function nudgeAlmostDue(): string {
  return `Quick heads up: today's question closes soon if you want to get your answer in!`;
}

export function weeklyRecapMessage(recapText: string): string {
  return recapText;
}
