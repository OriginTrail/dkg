export const HTTP_ERROR = (status, message) => Object.assign(new Error(message), { status });
