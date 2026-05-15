export const handler = async () => ({
  statusCode: 501,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
  },
  body: JSON.stringify({
    success: false,
    error: "Configura este proyecto para reutilizar la logica del webhook en Netlify Functions.",
  }),
});
