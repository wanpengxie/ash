package ai.ash.apps

import org.junit.Assert.assertEquals
import org.junit.Test

class PinTest {
    @Test fun aRequestThatWentNowhereIsToldOnceTheShellHasBeenInFront() {
        // ColorOS without the shortcut permission: no question, no callback, the shell keeps the focus.
        assertEquals(PinVerdict.WAIT, Pin.verdict(1_000, answered = false, asked = false, focusedFor = 1_000))
        assertEquals(PinVerdict.WAIT, Pin.verdict(Pin.WAIT_MS - 1, answered = false, asked = false, focusedFor = Pin.WAIT_MS - 1))
        assertEquals(PinVerdict.NOTHING, Pin.verdict(Pin.WAIT_MS, answered = false, asked = false, focusedFor = Pin.WAIT_MS))
        // A passing system note took the focus a moment: wait until the shell has had it back a while.
        assertEquals(PinVerdict.WAIT, Pin.verdict(Pin.WAIT_MS + 500, answered = false, asked = false, focusedFor = 200))
        assertEquals(PinVerdict.NOTHING, Pin.verdict(Pin.WAIT_MS + 2_000, answered = false, asked = false, focusedFor = Pin.SETTLE_MS))
    }

    @Test fun theLaunchersAnswerWinsAndANoIsTheOwnersChoice() {
        assertEquals(PinVerdict.ADDED, Pin.verdict(300, answered = true, asked = false, focusedFor = 0))
        assertEquals(PinVerdict.ADDED, Pin.verdict(Pin.GIVE_UP_MS + 1, answered = true, asked = true, focusedFor = 0))
        // The launcher asked (the shell was covered): while its question is up, keep waiting however long it takes.
        assertEquals(PinVerdict.WAIT, Pin.verdict(30_000, answered = false, asked = true, focusedFor = 0))
        // Back in the shell with nothing added (ColorOS permission note, or a no): the owner is told how to allow it.
        assertEquals(PinVerdict.NOTHING, Pin.verdict(30_000, answered = false, asked = true, focusedFor = Pin.SETTLE_MS))
        assertEquals(PinVerdict.GIVE_UP, Pin.verdict(Pin.GIVE_UP_MS, answered = false, asked = true, focusedFor = 0))
    }
}
