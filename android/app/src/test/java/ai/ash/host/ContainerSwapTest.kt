package ai.ash.host

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.StandardCopyOption

/** JVM stand-in for the Os-based operations: same semantics, never follows symlinks. */
private object NioTreeOps : TreeOps {
    override fun exists(f: File) = Files.exists(f.toPath(), LinkOption.NOFOLLOW_LINKS)
    override fun isRealDir(f: File) = Files.isDirectory(f.toPath(), LinkOption.NOFOLLOW_LINKS)
    override fun rename(from: File, to: File) { Files.move(from.toPath(), to.toPath(), StandardCopyOption.ATOMIC_MOVE) }
    override fun deleteTree(f: File) {
        if (!exists(f)) return
        if (isRealDir(f)) f.list().orEmpty().forEach { deleteTree(File(f, it)) }
        Files.delete(f.toPath())
    }
}

class ContainerSwapTest {
    @get:Rule val tmp = TemporaryFolder()

    private val base get() = tmp.root
    private val main get() = File(base, "main")
    private val old get() = File(base, "main.old")
    private val staging get() = File(base, "main.new")
    private fun swap() = ContainerSwap(main, old, staging, NioTreeOps)

    private fun tree(dir: File, version: String) {
        File(dir, "ubuntu/root/work").mkdirs()
        File(dir, "ubuntu/root/.dsh").mkdirs()
        File(dir, "ubuntu/root/.npmrc").writeText("registry=$version\n")
        File(dir, "VERSION").writeText(version)
    }

    @Test fun upgradeKeepsTheUsersHomeAndAddsWhatItLacks() {
        tree(main, "v1")
        File(main, "ubuntu/root/work/notes.md").writeText("mine")
        File(main, "ubuntu/root/.dsh").deleteRecursively()
        File(main, "ubuntu/root/.npmrc").writeText("my registry")
        tree(staging, "v2")
        File(staging, "ubuntu/root/.config/pip").mkdirs()
        // install(): main -> main.old, main.new -> main, then recover()
        NioTreeOps.rename(main, old)
        NioTreeOps.rename(staging, main)
        swap().recover()
        assertEquals("v2", File(main, "VERSION").readText())
        assertEquals("mine", File(main, "ubuntu/root/work/notes.md").readText())
        assertEquals("my registry", File(main, "ubuntu/root/.npmrc").readText())
        assertTrue(File(main, "ubuntu/root/.dsh").isDirectory)
        assertTrue(File(main, "ubuntu/root/.config/pip").isDirectory)
        assertFalse(File(main, "ubuntu/root.shipped").exists())
        assertFalse(old.exists())
    }

    @Test fun crashBetweenTheSwapRenamesRollsBack() {
        tree(main, "v1")
        File(main, "ubuntu/root/work/notes.md").writeText("mine")
        tree(staging, "v2")
        NioTreeOps.rename(main, old)
        swap().recover()
        assertEquals("v1", File(main, "VERSION").readText())
        assertEquals("mine", File(main, "ubuntu/root/work/notes.md").readText())
        assertFalse(old.exists())
        assertFalse(staging.exists())
    }

    @Test fun crashAfterTheShippedHomeWasSetAsideFinishes() {
        tree(old, "v1")
        File(old, "ubuntu/root/work/notes.md").writeText("mine")
        tree(main, "v2")
        NioTreeOps.rename(File(main, "ubuntu/root"), File(main, "ubuntu/root.shipped"))
        swap().recover()
        assertEquals("mine", File(main, "ubuntu/root/work/notes.md").readText())
        assertFalse(File(main, "ubuntu/root.shipped").exists())
        assertFalse(old.exists())
        swap().recover() // idempotent
        assertEquals("mine", File(main, "ubuntu/root/work/notes.md").readText())
    }

    @Test fun deletingNeverFollowsSymlinks() {
        val outside = File(base, "outside").apply { mkdirs() }
        File(outside, "keep").writeText("x")
        tree(old, "v1")
        Files.createSymbolicLink(File(old, "ubuntu/root/work/link").toPath(), outside.toPath())
        tree(main, "v2")
        swap().recover()
        // the user's home (with its link) moved into main; the old tree is gone; the target survives
        assertTrue(Files.isSymbolicLink(File(main, "ubuntu/root/work/link").toPath()))
        NioTreeOps.deleteTree(main)
        assertEquals("x", File(outside, "keep").readText())
    }

    @Test fun leftoverStagingIsDiscarded() {
        tree(main, "v1")
        tree(staging, "v2")
        swap().recover()
        assertFalse(staging.exists())
        assertEquals("v1", File(main, "VERSION").readText())
    }
}
