package ai.ash.apps

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
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

    @Test fun whenTheShellsOwnRequestGoesNowhereAshAsksOnceThenTheOwnerIsPointedAtAsh() {
        // ColorOS: the shell has no permission page, so Ash (which has one) asks instead.
        assertEquals(PinNext.ASK_ASH, Pin.afterNothing(PinLeg.SHELL, ashInstalled = true))
        assertEquals(PinNext.GUIDE_SHELL, Pin.afterNothing(PinLeg.SHELL, ashInstalled = false))
        // Ash's request came to nothing too: tell the owner to allow it for Ash — never ask again by itself.
        assertEquals(PinNext.GUIDE_ASH, Pin.afterNothing(PinLeg.ASH, ashInstalled = true))
        assertEquals(PinNext.GUIDE_ASH, Pin.afterNothing(PinLeg.ASH, ashInstalled = false))
    }

    @Test fun ashsAnswerDecidesWhetherToWatchOrToGuide() {
        assertNull(Pin.afterAshAnswer(ai.ash.bridge.Bridge.PIN_ASKED))
        assertEquals(PinNext.GUIDE_ASH, Pin.afterAshAnswer(ai.ash.bridge.Bridge.PIN_FAILED))
        assertEquals(PinNext.GUIDE_ASH, Pin.afterAshAnswer(ai.ash.bridge.Bridge.PIN_UNSUPPORTED))
        // An Ash too old to ask on the shell's behalf (or unreachable): only the shell's own permission is left.
        assertEquals(PinNext.GUIDE_SHELL, Pin.afterAshAnswer(0))
    }

    @Test fun onceAshsRequestWorkedAshAsksFirst() {
        assertEquals(PinLeg.SHELL, Pin.firstLeg(viaAsh = false, ashInstalled = true))
        assertEquals(PinLeg.ASH, Pin.firstLeg(viaAsh = true, ashInstalled = true))
        assertEquals(PinLeg.SHELL, Pin.firstLeg(viaAsh = true, ashInstalled = false))
    }
}
