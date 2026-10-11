// Log lines never carry full phone numbers: a run of 7+ digits keeps only its last four.
// ISO dates and times are left alone.
export function maskPhones(text) {
  return String(text ?? '').replace(/\+?\(?\d[\d\s().-]{5,}\d/g, match => {
    if (/^\d{4}-\d{2}-\d{2}/.test(match)) return match;
    const digits = match.replace(/\D/g, '');
    return digits.length >= 7 ? `…${digits.slice(-4)}` : match;
  });
}

// Error messages can echo request data (database errors quote values), so mask and shorten them.
export function safeMessage(error) {
  return maskPhones(error?.message ?? error).slice(0, 200);
}
