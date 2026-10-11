import XCTest

/// Walks the 3-minute demo script with seeded memories and attaches a
/// screenshot of each step (export with `xcrun xcresulttool export attachments`).
final class WalkthroughTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    func testDemoScript() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-RecallInMemoryStore", "-RecallDemo", "-RecallSkipOnboarding"]
        app.launch()

        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Ask me anything'")).firstMatch.waitForExistence(timeout: 10))
        sleep(2)
        attach(app, "01-home")

        // Steph speaks first: the Priya reminder.
        app.buttons["Settings"].tap()
        let demoReminder = app.buttons["Show Priya reminder"]
        for _ in 0..<5 where !demoReminder.isHittable { app.scrollViews.firstMatch.swipeUp() }
        XCTAssertTrue(demoReminder.isHittable)
        demoReminder.tap()
        XCTAssertTrue(app.buttons["Tell me more"].waitForExistence(timeout: 10))
        sleep(1)
        attach(app, "02-reminder")
        app.buttons["Thanks!"].tap()

        // "Where are my keys?"
        let field = app.textFields["Type to Steph"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("Hey Steph, where are my keys\n")
        XCTAssertTrue(app.buttons["Found them!"].waitForExistence(timeout: 30))
        sleep(1)
        attach(app, "03-keys")
        // "Not there" lowers that memory's confidence and looks again.
        app.buttons["Not there"].tap()
        let unsure = app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'not sure'")).firstMatch
        XCTAssertTrue(unsure.waitForExistence(timeout: 30))
        sleep(1)
        attach(app, "03b-not-there")
        app.buttons["Okay"].tap()
        field.tap()
        field.typeText("Where are my keys?\n")
        XCTAssertTrue(app.buttons["Found them!"].waitForExistence(timeout: 30))
        app.buttons["Found them!"].tap()

        // "Who's Sam again?"
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("Who's Sam again?\n")
        let promise = app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Tokyo ramen'")).firstMatch
        XCTAssertTrue(promise.waitForExistence(timeout: 30))
        sleep(1)
        attach(app, "04-sam")
        app.buttons["Thanks!"].tap()

        // Something to remember.
        field.tap()
        field.typeText("I put my passport in the desk drawer\n")
        XCTAssertTrue(app.buttons["Okay"].waitForExistence(timeout: 10))
        attach(app, "05-note")
        app.buttons["Okay"].tap()

        field.tap()
        field.typeText("Where is my passport?\n")
        XCTAssertTrue(app.buttons["Found it!"].waitForExistence(timeout: 30))
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'desk drawer'")).firstMatch.exists)
        sleep(1)
        attach(app, "06-passport")
    }

    func testSettingsExplainsMemoryConnection() {
        let app = XCUIApplication()
        app.launchArguments = ["-RecallInMemoryStore", "-RecallSkipOnboarding", "-demoMode", "NO"]
        app.launch()
        XCTAssertTrue(app.buttons["Settings"].waitForExistence(timeout: 10))
        app.buttons["Settings"].tap()
        XCTAssertTrue(app.staticTexts["Memories on this phone only"].waitForExistence(timeout: 5))
        let code = app.secureTextFields["memory-access-code"]
        XCTAssertTrue(code.exists)
        XCTAssertFalse(app.buttons["Connect memories"].isEnabled)
        attach(app, "07-memory-connection")
    }

    func testMedicineDemoCard() {
        let app = XCUIApplication()
        app.launchArguments = ["-RecallInMemoryStore", "-RecallDemo", "-RecallSkipOnboarding"]
        app.launch()
        XCTAssertTrue(app.buttons["Settings"].waitForExistence(timeout: 10))
        app.buttons["Settings"].tap()
        let medicineReminder = app.buttons["Show medicine reminder"]
        for _ in 0..<5 where !medicineReminder.isHittable { app.scrollViews.firstMatch.swipeUp() }
        XCTAssertTrue(medicineReminder.isHittable)
        medicineReminder.tap()
        XCTAssertTrue(app.staticTexts["This is your demo reminder to take your medicine."].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["DEMO · FICTIONAL REMINDER"].exists)
        attach(app, "medicine-demo")
        app.buttons["Thanks!"].tap()
        XCTAssertTrue(app.textFields["Type to Steph"].waitForExistence(timeout: 5))
    }

    func testOnboardingScreens() {
        let app = XCUIApplication()
        app.launchArguments = ["-RecallInMemoryStore", "-phase", "signUp"]
        app.launch()
        XCTAssertTrue(app.buttons["Get started"].waitForExistence(timeout: 10))
        sleep(1)
        attach(app, "00a-sign-up")
        app.terminate()

        app.launchArguments = ["-RecallInMemoryStore", "-phase", "permissions"]
        app.launch()
        XCTAssertTrue(app.buttons["Yes, let's go"].waitForExistence(timeout: 10))
        sleep(1)
        attach(app, "00b-permission")
        app.buttons["Let me pick"].tap()
        sleep(1)
        attach(app, "00c-permission-pick")
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
