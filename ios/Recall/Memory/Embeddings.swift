import Foundation
import NaturalLanguage

/// Turns text into vectors. The backend (Voyage) is preferred; Apple's
/// on-device sentence embedding keeps search working offline.
enum EmbeddingKind: String, Sendable { case document, query }

struct EmbeddingBatch: Sendable {
    var model: String
    var vectors: [[Float]]
}

protocol Embedder: Sendable {
    func embed(_ texts: [String], kind: EmbeddingKind) async -> EmbeddingBatch?
}

struct OnDeviceEmbedder: Embedder {
    static let model = "apple-nl-sentence-en"

    func embed(_ texts: [String], kind: EmbeddingKind) async -> EmbeddingBatch? {
        guard let embedding = NLEmbedding.sentenceEmbedding(for: .english) else { return nil }
        var vectors: [[Float]] = []
        for text in texts {
            guard let vector = embedding.vector(for: String(text.prefix(1000))) else { return nil }
            vectors.append(vector.map(Float.init))
        }
        return EmbeddingBatch(model: Self.model, vectors: vectors)
    }
}

/// Tries each embedder in order and returns the first that answers.
struct ChainedEmbedder: Embedder {
    var embedders: [any Embedder]

    func embed(_ texts: [String], kind: EmbeddingKind) async -> EmbeddingBatch? {
        for embedder in embedders {
            if let batch = await embedder.embed(texts, kind: kind), batch.vectors.count == texts.count { return batch }
        }
        return nil
    }

    /// Embeds a query with a specific model so it can be compared with
    /// memories stored under that model.
    func embed(query: String, model: String) async -> [Float]? {
        for embedder in embedders {
            if let batch = await embedder.embed([query], kind: .query), batch.model == model { return batch.vectors.first }
        }
        return nil
    }
}
