package ai.ash.sysapps.team;

import ai.ash.sysapps.SystemAppActivity;
import ai.ash.ui.HumanCall;
import ai.ash.ui.HumanPort;
import ai.ash.ui.LedgerFeed;
import ai.ash.ui.UiIo;
import ai.ash.ui.UiDrafts;
import ai.ash.ui.KeyedRowsAdapter;
import ai.ash.ui.ChatRow;
import ai.ash.link.Repo;
import java.nio.file.Files;
import android.app.Application;
import android.content.Context;
import android.content.Intent;
import android.os.Looper;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Spinner;
import android.view.View;
import android.view.ViewGroup;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.ArrayList;
import java.util.List;
import kotlin.Unit;
import kotlin.jvm.functions.Function0;
import kotlin.jvm.functions.Function1;
import kotlin.jvm.functions.Function2;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.util.ReflectionHelpers;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, application = Application.class, instrumentedPackages = {"ai.ash.ui"}, shadows = {TeamActivityAcceptanceTest.Port.class, TeamActivityAcceptanceTest.Feed.class, TeamActivityAcceptanceTest.Io.class})
public class TeamActivityAcceptanceTest {
    static final class Read {
        final String word; final JSONObject body; final Function2<JSONObject, HumanPort.Failure, Unit> done;
        Read(String word, JSONObject body, Function2<JSONObject, HumanPort.Failure, Unit> done) { this.word = word; this.body = body; this.done = done; }
        void answer(String json) throws Exception { done.invoke(new JSONObject(json), null); idle(); }
        void fail(String code, String message) { done.invoke(null,new HumanPort.Failure(code,message)); idle(); }
    }
    static final List<Read> reads = new ArrayList<>();
    static void idle() { Shadows.shadowOf(Looper.getMainLooper()).idle(); }
    static Intent intent(String agent) { return new Intent(RuntimeEnvironment.getApplication(), TeamActivity.class).putExtra(SystemAppActivity.EXTRA_ARG, "{\"agent\":\"" + agent + "\"}"); }
    static Read last(String word) { return reads.stream().filter(r -> r.word.equals(word)).reduce((a,b)->b).orElseThrow(); }
    static EditText input(TeamActivity a) { return ReflectionHelpers.getField(a, "input"); }
    static String member(TeamActivity a) { return ReflectionHelpers.getField(a, "selected"); }
    @Before public void reset() {
        reads.clear(); Feed.listener = null;
        ReflectionHelpers.setStaticField(UiDrafts.class, "drafts", null);
        Map<?,?> pending = ReflectionHelpers.getStaticField(TeamActivity.class, "sharedPending"); pending.clear();
        ReflectionHelpers.setStaticField(TeamActivity.class, "pendingLoaded", false);
        RuntimeEnvironment.getApplication().getSharedPreferences("ash.drafts", Context.MODE_PRIVATE).edit().clear().commit();
        RuntimeEnvironment.getApplication().getSharedPreferences("ash.team.pending", Context.MODE_PRIVATE).edit().clear().commit();
    }
    @Test public void reusedActivityOpensNewMemberAndRetainsEachDraft() throws Exception {
        try (ActivityController<TeamActivity> c = Robolectric.buildActivity(TeamActivity.class, intent("agent:a")).create().start().resume()) {
            TeamActivity a = c.get(); idle();
            last("list").answer("{\"agents\":[{\"id\":\"agent:a\",\"name\":\"Alice\",\"state\":\"idle\"},{\"id\":\"agent:b\",\"name\":\"Bob\",\"state\":\"idle\"}]}");
            input(a).setText("Alice draft");
            Read old = last("exchanges");
            c.newIntent(intent("agent:b")); idle();
            assertEquals("agent:b", member(a));
            assertEquals("", input(a).getText().toString());
            input(a).setText("Bob draft");
            old.answer("{\"items\":[{\"id\":\"old\",\"seq\":1,\"from\":\"agent:a\",\"to\":\"agent:a\",\"word\":\"ask\",\"text\":\"OLD RESULT\",\"state\":\"waiting\"}]}");
            assertEquals("Bob draft", input(a).getText().toString());
            TeamModel.Read<?> current = ReflectionHelpers.getField(a, "exchanges");
            assertNull(current.getValue());
            assertEquals("agent:b", ((Spinner)ReflectionHelpers.getField(a,"targets")).getSelectedItemPosition() == 1 ? "agent:b" : "wrong target");
            c.newIntent(intent("agent:a")); idle();
            assertEquals("agent:a", member(a)); assertEquals("Alice draft", input(a).getText().toString());
            c.newIntent(intent("agent:b")); idle();
            assertEquals("Bob draft", input(a).getText().toString());
        }
    }
    static final String MEMBERS = "{\"agents\":[{\"id\":\"agent:a\",\"name\":\"Alice\",\"summary\":\"Research\",\"brief\":\"Research\",\"state\":\"idle\",\"runtime\":{\"kind\":\"dsh\",\"model\":\"one\"},\"tools\":[\"secret_tool\"],\"words\":[\"service:private/*\"]},{\"id\":\"agent:b\",\"name\":\"Bob\",\"state\":\"idle\"}]}";
    static TextView label(View root, String value) {
        if (root instanceof TextView && value.equals(((TextView)root).getText().toString())) return (TextView)root;
        if (root instanceof ViewGroup) for (int i=0;i<((ViewGroup)root).getChildCount();i++) { TextView v=label(((ViewGroup)root).getChildAt(i),value); if(v!=null)return v; }
        return null;
    }
    static EditText field(View root, String value) {
        if (root instanceof EditText && value.equals(String.valueOf(root.getContentDescription()))) return (EditText)root;
        if (root instanceof ViewGroup) for (int i=0;i<((ViewGroup)root).getChildCount();i++) { EditText v=field(((ViewGroup)root).getChildAt(i),value); if(v!=null)return v; }
        return null;
    }
    static List<ChatRow> rowData(TeamActivity a) { return ((KeyedRowsAdapter)ReflectionHelpers.getField(a,"rows")).getCurrentList(); }
    static ChatRow row(TeamActivity a, String key) throws Exception {
        long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(4);
        do {
            idle();
            for (ChatRow r:rowData(a)) if(r.getKey().startsWith(key)) return r;
            Thread.sleep(1);
        } while(System.nanoTime()<end);
        throw new AssertionError("Missing row: "+key);
    }
    static View detail(TeamActivity a) throws Exception { return row(a,"detail:").getMake().invoke(); }
    static String text(View root) {
        String s=root instanceof TextView ? ((TextView)root).getText().toString()+"\n" : "";
        if(root instanceof ViewGroup) for(int i=0;i<((ViewGroup)root).getChildCount();i++) s+=text(((ViewGroup)root).getChildAt(i));
        return s;
    }
    @Test public void pendingReceiptBelongsToOldMemberAndCannotClearTheNewMembersDraft() throws Exception {
        try(ActivityController<TeamActivity> c=Robolectric.buildActivity(TeamActivity.class,intent("agent:a")).create().start().resume()) {
            TeamActivity a=c.get(); last("list").answer(MEMBERS);
            input(a).setText("Alice question"); ((TextView)ReflectionHelpers.getField(a,"send")).performClick();
            Read send=last("send"); assertEquals("agent:a",send.body.getJSONObject("body").getString("agent")); assertFalse(send.body.getBoolean("wait"));
            c.newIntent(intent("agent:b")); idle(); input(a).setText("Bob unsent");
            send.answer("{\"ok\":true,\"message\":{\"id\":\"alice-request\",\"seq\":7}}");
            assertEquals("Bob unsent",input(a).getText().toString());
            Map<String,TeamSend> pending=ReflectionHelpers.getStaticField(TeamActivity.class,"sharedPending");
            TeamSend kept=pending.values().iterator().next(); assertEquals("agent:a",kept.getAgent()); assertEquals("alice-request",kept.getLedgerId());
            assertFalse(kept.getClientId().isBlank());
        }
    }
    @Test public void memberScreenShowsWorkAndKeepsRawPolicyInAdvancedConfiguration() throws Exception {
        try(ActivityController<TeamActivity> c=Robolectric.buildActivity(TeamActivity.class,intent("agent:a")).create().start().resume()) {
            TeamActivity a=c.get(); last("list").answer(MEMBERS);
            View card=detail(a);
            assertNull(label(card,"工具：secret_tool")); assertNull(label(card,"接口：service:private/*"));
            assertNotNull(label(card,"修改配置")); label(card,"修改配置").performClick(); idle();
            View form=ReflectionHelpers.getField(a,"formSlot");
            EditText tools=field(form,"可用工具"); assertNotNull(tools); assertFalse(tools.isShown());
            label(form,"高级配置").performClick(); idle(); assertEquals(View.VISIBLE,((View)tools.getParent()).getVisibility());
            assertNotNull(label(card,"更多操作"));
        }
    }
    @Test public void unknownMemberCannotFallBackToAnotherExecutionIdentity() throws Exception {
        try(ActivityController<TeamActivity> c=Robolectric.buildActivity(TeamActivity.class,intent("agent:missing")).create().start().resume()) {
            TeamActivity a=c.get(); last("list").answer(MEMBERS);
            assertEquals("agent:missing",ReflectionHelpers.getField(a,"target"));
            assertFalse(((TextView)ReflectionHelpers.getField(a,"send")).isEnabled());
        }
    }
    @Test public void homePutsRealDelegationBeforeTheFullMemberListThenShowsReplyAndContinue() throws Exception {
        JSONObject session=new JSONObject(Files.readString(Repo.INSTANCE.getRoot().toPath().resolve("packages/core/test/fixtures/team-session.json")));
        JSONObject during=session.getJSONObject("during"), answered=session.getJSONObject("answered");
        try(ActivityController<TeamActivity> c=Robolectric.buildActivity(TeamActivity.class,new Intent(RuntimeEnvironment.getApplication(),TeamActivity.class)).create().start().resume()) {
            TeamActivity a=c.get(); last("list").answer(during.getJSONObject("members").toString());
            last("exchanges").answer(during.getJSONObject("exchanges").toString());
            View delegation=row(a,"exchange:").getMake().invoke();
            assertTrue(text(delegation).contains("整理这次应用验收结果，先检查团队入口复用"));
            assertTrue(text(delegation).contains("等回答"));
            List<ChatRow> initial=rowData(a);
            assertEquals("team:overview",initial.get(0).getKey());
            assertTrue(initial.stream().noneMatch(r->r.getKey().startsWith("member:")));
            assertTrue(initial.indexOf(row(a,"exchange:"))<=2);
            assertTrue(during.getJSONObject("members").getJSONArray("agents").length()>6);
            assertTrue(text(initial.get(0).getMake().invoke()).contains("资料帮手"));
            Feed.listener.invoke(new JSONObject("{\"kind\":\"response\",\"from\":\"service:agents\",\"word\":\"ask\"}"));
            last("exchanges").answer(answered.getJSONObject("exchanges").toString());
            long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(4);
            do { idle(); delegation=row(a,"exchange:").getMake().invoke(); if(label(delegation,"继续问")!=null)break; Thread.sleep(1); } while(System.nanoTime()<end);
            assertTrue(text(delegation).contains("发现复用入口会留在上一个成员"));
            label(delegation,"继续问").performClick();
            assertEquals("agent:research",ReflectionHelpers.getField(a,"target"));
            input(a).setText("这个问题会丢掉我刚输入的内容吗？");
            ((TextView)ReflectionHelpers.getField(a,"send")).performClick();
            Read sent=last("send"); assertEquals("agent:research",sent.body.getJSONObject("body").getString("agent"));
            assertEquals("这个问题会丢掉我刚输入的内容吗？",sent.body.getJSONObject("body").getString("text"));
        }
    }
    @Test public void configurationFormSubmitsTheChosenModelRoleAndToolPolicy() throws Exception {
        try(ActivityController<TeamActivity> c=Robolectric.buildActivity(TeamActivity.class,intent("agent:a")).create().start().resume()) {
            TeamActivity a=c.get(); last("list").answer(MEMBERS); label(detail(a),"修改配置").performClick();
            View form=ReflectionHelpers.getField(a,"formSlot");
            last("runtimes").answer("{\"runtimes\":[{\"kind\":\"dsh\",\"models\":[{\"id\":\"one\"},{\"id\":\"two\"}]}]}");
            last("runtime.catalog").answer("{\"providers\":[{\"models\":[{\"id\":\"one\"},{\"id\":\"two\"}]}]}");
            field(form,"名字").setText("编辑帮手"); field(form,"一句话说明角色").setText("编辑并回复结果");
            label(form,"高级配置").performClick(); field(form,"可用工具").setText("write");
            Spinner models=findSpinner(form,"帮手使用的模型"); assertNotNull(models); models.setSelection(1); idle();
            label(form,"保存").performClick();
            Read update=last("update"); assertEquals("agent:a",update.body.getString("agent"));
            assertEquals("编辑帮手",update.body.getString("name")); assertEquals("编辑并回复结果",update.body.getString("brief"));
            assertEquals("two",update.body.getJSONObject("runtime").getString("model"));
            assertEquals("write",update.body.getJSONArray("tools").getString(0));
            update.fail("result_unknown","尚未收到结果");
            assertEquals("编辑帮手",field(form,"名字").getText().toString());
        }
    }
    static Spinner findSpinner(View root,String description) {
        if(root instanceof Spinner && description.equals(String.valueOf(root.getContentDescription()))) return (Spinner)root;
        if(root instanceof ViewGroup)for(int i=0;i<((ViewGroup)root).getChildCount();i++){Spinner s=findSpinner(((ViewGroup)root).getChildAt(i),description);if(s!=null)return s;}
        return null;
    }
    @Implements(value = HumanCall.class, isInAndroidSdk = false)
    public static class Port {
        @Implementation protected void call(Context ctx, String to, String word, JSONObject body, Function2<JSONObject, HumanPort.Failure, Unit> done) { reads.add(new Read(word, body, done)); }
        @Implementation protected void request(Context ctx, JSONObject request, Function2<JSONObject, HumanPort.Failure, Unit> done) { reads.add(new Read("send", request, done)); }
    }
    @Implements(value = LedgerFeed.class, isInAndroidSdk = false)
    public static class Feed {
        static Function1<JSONObject,Unit> listener;
        @Implementation protected void listen(Context ctx, Function1<JSONObject, Unit> message, Function1<Boolean, Unit> connection) { listener=message; connection.invoke(true); }
        @Implementation protected void remove(Function1<JSONObject, Unit> message) {}
    }
    @Implements(value = UiIo.class, isInAndroidSdk = false)
    public static class Io {
        @Implementation protected void disk(Function0<Unit> work) { work.invoke(); }
        @Implementation protected void ui(Function0<Unit> work) { work.invoke(); }
    }
}
