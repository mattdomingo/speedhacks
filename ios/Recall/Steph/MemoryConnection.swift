import Foundation
import Security

/// Provisioned for one patient's device; never read from Info.plist or UserDefaults.
struct MemoryCredentials: Codable, Sendable, Equatable {
    var token: String
    var pin: String
    var endpoint: String
}

enum MemoryConnection {
    private static let service = "Recall.connected-memories"
    private static let account = "device"

    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    static func load(endpoint: URL?) -> MemoryCredentials? {
        guard let endpoint else { return nil }
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(request as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data,
              let credentials = try? JSONDecoder().decode(MemoryCredentials.self, from: data),
              credentials.endpoint == endpoint.absoluteString else { return nil }
        return credentials
    }

    static func save(_ credentials: MemoryCredentials) throws {
        let data = try JSONEncoder().encode(credentials)
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            item[kSecValueData as String] = data
            item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw ConnectionError.keychain }
        } else if status != errSecSuccess { throw ConnectionError.keychain }
    }

    static func remove() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw ConnectionError.keychain }
    }

    enum ConnectionError: Error { case keychain }
}
