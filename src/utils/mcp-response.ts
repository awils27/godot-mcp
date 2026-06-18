export function createErrorResponse(message: string, possibleSolutions: string[] = []): object {
  const response: {
    content: Array<{ type: 'text'; text: string }>;
    isError: true;
  } = {
    content: [
      {
        type: 'text',
        text: message,
      },
    ],
    isError: true,
  };

  if (possibleSolutions.length > 0) {
    response.content.push({
      type: 'text',
      text: 'Possible solutions:\n- ' + possibleSolutions.join('\n- '),
    });
  }

  return response;
}
