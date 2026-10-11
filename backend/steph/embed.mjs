const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';

function upstreamError() {
  const error = new Error('Embedding service failed');
  error.status = 502;
  return error;
}

export async function embedTexts(fetchImpl, apiKey, model, texts, inputType) {
  let body;
  try {
    const response = await fetchImpl(VOYAGE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: texts, model, input_type: inputType }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      console.error('Embedding request failed:', response.status);
      throw upstreamError();
    }
    body = await response.json();
  } catch (error) {
    if (error.status === 502) throw error;
    console.error('Embedding request failed:', error.name);
    throw upstreamError();
  }
  // Voyage tags each vector with its input index; restore input order before replying.
  const embeddings = Array.isArray(body?.data)
    ? [...body.data].sort((a, b) => a.index - b.index).map(item => item.embedding) : [];
  const dimensions = embeddings[0]?.length;
  if (embeddings.length !== texts.length || !dimensions || !embeddings.every(vector =>
    Array.isArray(vector) && vector.length === dimensions && vector.every(Number.isFinite))) {
    console.error('Embedding service returned an unexpected shape');
    throw upstreamError();
  }
  return { model: body.model || model, dimensions, embeddings };
}
