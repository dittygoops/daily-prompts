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

export function shareMessage(partnerName: string, responseText: string): string {
  return `${partnerName} said:\n\n${responseText}`;
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
