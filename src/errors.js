const ERROR_PATTERNS = [
  {
    name: 'age',
    regex: /sign in to confirm your age|age-restricted/i,
    userMessage: 'This video is age-restricted. Provide valid YouTube cookies.'
  },
  {
    name: 'private',
    regex: /private video/i,
    userMessage: 'This video is private and requires access.'
  },
  {
    name: 'geo',
    regex: /not available in your country/i,
    userMessage: 'This video is not available in your region.'
  },
  {
    name: 'unavailable',
    regex: /video unavailable|this video is not available|account associated with this video has been terminated/i,
    userMessage: 'This video is unavailable or has been removed.'
  },
  {
    name: 'format',
    regex: /only images are available|requested format is not available|signature solving failed|n challenge solving failed/i,
    userMessage:
      'YouTube blocked format extraction. Check yt-dlp remote components and cookies.'
  },
  {
    name: 'timeout',
    regex: /timed out/i,
    userMessage: 'The stream timed out while starting.'
  }
];

function normalizeErrorMessage(error) {
  if (!error) {
    return '';
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

function pickFirstErrorLine(message) {
  const lines = message.split('\n').map((line) => line.trim()).filter(Boolean);
  const errorLine = lines.find((line) => line.startsWith('ERROR:'));
  if (errorLine) {
    return errorLine;
  }
  return lines[0] || '';
}

function summarizeError(error, maxLength = 280) {
  const message = normalizeErrorMessage(error);
  const base = pickFirstErrorLine(message) || message;
  const compact = base.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength - 3)}...`;
}

function getUserFacingError(error) {
  const message = normalizeErrorMessage(error);
  if (!message) {
    return null;
  }
  const match = ERROR_PATTERNS.find((entry) => entry.regex.test(message));
  return match ? match.userMessage : null;
}

module.exports = {
  getUserFacingError,
  summarizeError
};
