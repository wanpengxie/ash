package ai.ash.sysapps.team;

import ai.ash.sysapps.SystemAppActivity;
import ai.ash.ui.HumanCall;
import ai.ash.ui.HumanPort;
import ai.ash.ui.LedgerFeed;
import ai.ash.ui.UiIo;
import ai.ash.ui.UiDrafts;
import ai.ash.link.Repo;
import ai.ash.link.LinkClient;
import ai.ash.link.TestLink;
import java.nio.file.Files;
import java.nio.charset.StandardCharsets;
import android.app.Application;
import android.content.Context;
import android.content.Intent;
import android.os.Looper;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Spinner;
import android.view.View;
import android.view.ViewGroup;
import android.view.MotionEvent;
import android.os.SystemClock;
import android.graphics.Rect;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import androidx.recyclerview.widget.RecyclerView;
import java.io.File;
import java.io.FileOutputStream;
import org.robolectric.annotation.GraphicsMode;
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
import org.junit.After;
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
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = 35, qualifiers = "w360dp-h800dp-mdpi", application = Application.class, instrumentedPackages = {"ai.ash.ui", "ai.ash.sysapps"}, shadows = {TeamActivityAcceptanceTest.BaseClient.class, TeamActivityAcceptanceTest.Port.class, TeamActivityAcceptanceTest.Feed.class, TeamActivityAcceptanceTest.Io.class})
public class TeamActivityAcceptanceTest {
    // Supply the existing test LinkClient at the base's documented seam; no host Runtime/Keystore is started.
    static TestLink link;
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
        link = new TestLink(); reads.clear(); Feed.listener = null; Feed.client = null; Port.clientCalls = 0;
        ReflectionHelpers.setStaticField(UiDrafts.class, "drafts", null);
        Map<?,?> pending = ReflectionHelpers.getStaticField(TeamActivity.class, "sharedPending"); pending.clear();
        ReflectionHelpers.setStaticField(TeamActivity.class, "pendingLoaded", false);
        RuntimeEnvironment.getApplication().getSharedPreferences("ash.drafts", Context.MODE_PRIVATE).edit().clear().commit();
        RuntimeEnvironment.getApplication().getSharedPreferences("ash.team.pending", Context.MODE_PRIVATE).edit().clear().commit();
    }
    @After public void closeLink() { if(link!=null)link.close(); }
    @Test public void reusedActivityOpensNewMemberAndRetainsEachDraft() throws Exception {
        try (ActivityController<TeamActivity> c = Robolectric.buildActivity(TeamActivity.class, intent("agent:a")).create().start().resume().visible()) {
            TeamActivity a = c.get(); idle();
            assertTrue("Base reads must use the LinkClient overload",Port.clientCalls>0);
            assertSame(link.getClient(),Feed.client);
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
    static View described(View root,String description) {
        if(description.equals(String.valueOf(root.getContentDescription())))return root;
        if(root instanceof ViewGroup)for(int i=0;i<((ViewGroup)root).getChildCount();i++){View v=described(((ViewGroup)root).getChildAt(i),description);if(v!=null)return v;}
        return null;
    }
    static void layout(TeamActivity a) {
        idle(); View decor=a.getWindow().getDecorView();
        assertEquals("Phone resource width",360,a.getResources().getConfiguration().screenWidthDp);
        assertEquals("mdpi fixture density",1f,a.getResources().getDisplayMetrics().density,0.001f);
        decor.measure(View.MeasureSpec.makeMeasureSpec(360,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(800,View.MeasureSpec.EXACTLY));
        decor.layout(0,0,360,800); idle();
        assertEquals("Measured phone width in dp",360f,decor.getWidth()/a.getResources().getDisplayMetrics().density,0.01f);
    }
    static boolean visible(View v) { Rect r=new Rect(); return v!=null && v.isShown() && v.getGlobalVisibleRect(r) && r.width()>0 && r.height()>=Math.min(v.getHeight(),40); }
    static TextView screenText(TeamActivity a,String value,boolean scroll) throws Exception {
        long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);
        do {
            layout(a); TextView v=label(a.getWindow().getDecorView(),value);
            if(visible(v))return v;
            if(scroll)((RecyclerView)ReflectionHelpers.getField(a,"list")).scrollBy(0,70);
            Thread.sleep(2);
        }while(System.nanoTime()<end);
        throw new AssertionError("Not visible on the Activity screen: "+value);
    }
    static void touch(TeamActivity a,View v) {
        assertTrue("Touch target must be visible",visible(v));
        Rect local=new Rect();assertTrue(v.getLocalVisibleRect(local));
        assertTrue("Touch center must be inside the visible part of the control",local.contains(v.getWidth()/2,v.getHeight()/2));
        int[] at=new int[2];v.getLocationInWindow(at);float x=at[0]+v.getWidth()/2f,y=at[1]+v.getHeight()/2f;
        long now=SystemClock.uptimeMillis();View decor=a.getWindow().getDecorView();
        MotionEvent down=MotionEvent.obtain(now,now,MotionEvent.ACTION_DOWN,x,y,0),up=MotionEvent.obtain(now,now+20,MotionEvent.ACTION_UP,x,y,0);
        assertTrue(decor.dispatchTouchEvent(down));decor.dispatchTouchEvent(up);down.recycle();up.recycle();idle();
    }
    static View detail(TeamActivity a) throws Exception { return (View)screenText(a,"修改配置",true).getParent(); }
    static String text(View root) {
        String s=root instanceof TextView ? ((TextView)root).getText().toString()+"\n" : "";
        if(root instanceof ViewGroup) for(int i=0;i<((ViewGroup)root).getChildCount();i++) s+=text(((ViewGroup)root).getChildAt(i));
        return s;
    }
    static void screenshot(TeamActivity a,String name) throws Exception {
        layout(a);View decor=a.getWindow().getDecorView();Bitmap bitmap=Bitmap.createBitmap(decor.getWidth(),decor.getHeight(),Bitmap.Config.ARGB_8888);decor.draw(new Canvas(bitmap));
        File file=new File("build/reports/team-acceptance/"+name+".png");assertTrue(file.getParentFile().isDirectory()||file.getParentFile().mkdirs());
        try(FileOutputStream out=new FileOutputStream(file)){assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG,100,out));}bitmap.recycle();
    }
    @Test public void pendingReceiptBelongsToOldMemberAndCannotClearTheNewMembersDraft() throws Exception {
        try(ActivityController<TeamActivity> c=Robolectric.buildActivity(TeamActivity.class,intent("agent:a")).create().start().resume().visible()) {
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
        try(ActivityController<TeamActivity> c=Robolectric.buildActivity(TeamActivity.class,intent("agent:a")).create().start().resume().visible()) {
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
        try(ActivityController<TeamActivity> c=Robolectric.buildActivity(TeamActivity.class,intent("agent:missing")).create().start().resume().visible()) {
            TeamActivity a=c.get(); last("list").answer(MEMBERS);
            assertEquals("agent:missing",ReflectionHelpers.getField(a,"target"));
            assertFalse(((TextView)ReflectionHelpers.getField(a,"send")).isEnabled());
        }
    }
    @Test public void homePutsRealDelegationBeforeTheFullMemberListThenShowsReplyAndContinue() throws Exception {
        JSONObject session=new JSONObject(new String(Files.readAllBytes(Repo.INSTANCE.getRoot().toPath().resolve("packages/core/test/fixtures/team-session.json")),StandardCharsets.UTF_8));
        JSONObject during=session.getJSONObject("during"), answered=session.getJSONObject("answered");
        try(ActivityController<TeamActivity> c=Robolectric.buildActivity(TeamActivity.class,new Intent(RuntimeEnvironment.getApplication(),TeamActivity.class)).create().start().resume().visible()) {
            TeamActivity a=c.get(); last("list").answer(during.getJSONObject("members").toString());
            last("exchanges").answer(during.getJSONObject("exchanges").toString());
            TextView question=screenText(a,"整理这次应用验收结果，先检查团队入口复用",false);
            assertTrue(visible(question)); assertTrue(during.getJSONObject("members").getJSONArray("agents").length()>6);
            assertNotNull(screenText(a,"委托与回复",false));
            for(String action:new String[]{"成员","刷新","新建"})assertTrue("Header action needs a 48dp touch width",screenText(a,action,false).getWidth()>=48);
            assertFalse(text(a.getWindow().getDecorView()).contains("配置模型："));
            screenshot(a,"01-working-delegation");
            touch(a,screenText(a,"资料帮手",false));
            assertEquals("agent:research",member(a)); assertEquals("agent:research",last("exchanges").body.getString("agent"));
            last("exchanges").answer(during.getJSONObject("exchanges").toString());
            layout(a);touch(a,described(a.getWindow().getDecorView(),"返回"));
            assertEquals("team",ReflectionHelpers.getField(a,"route"));
            last("exchanges").answer(during.getJSONObject("exchanges").toString());
            Read priorMembers=last("list"),priorExchanges=last("exchanges");
            Feed.listener.invoke(session.getJSONObject("answerEvent"));
            assertNotSame("Production ledger handler must request fresh members",priorMembers,last("list"));
            assertNotSame("Production ledger handler must request fresh exchanges",priorExchanges,last("exchanges"));
            last("list").answer(answered.getJSONObject("members").toString());
            last("exchanges").answer(answered.getJSONObject("exchanges").toString());
            assertNotNull(screenText(a,"成员当前没有正在执行的工作",false));
            TextView continueButton=screenText(a,"继续问",true);
            assertTrue(text(a.getWindow().getDecorView()).contains("发现复用入口会留在上一个成员"));
            screenshot(a,"02-reply-and-follow-up");
            touch(a,continueButton);
            assertEquals("agent:research",ReflectionHelpers.getField(a,"target"));
            input(a).setText("这个问题会丢掉我刚输入的内容吗？");
            touch(a,screenText(a,"发送",false));
            Read sent=last("send"); assertEquals("agent:research",sent.body.getJSONObject("body").getString("agent"));
            assertEquals("这个问题会丢掉我刚输入的内容吗？",sent.body.getJSONObject("body").getString("text"));
        }
    }
    @Test public void configurationFormSubmitsTheChosenModelRoleAndToolPolicy() throws Exception {
        try(ActivityController<TeamActivity> c=Robolectric.buildActivity(TeamActivity.class,intent("agent:a")).create().start().resume().visible()) {
            TeamActivity a=c.get(); last("list").answer(MEMBERS); label(detail(a),"修改配置").performClick();
            View form=ReflectionHelpers.getField(a,"formSlot");
            assertTrue(label(form,"运行中的帮手：更改角色或工具会重启并中断当前委托；模型变更按运行时在下一轮生效或重启。").isShown());
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
    @Test public void sendingReceiptRefusalAndUnknownHaveDistinctVisibleFeedback() throws Exception {
        try(ActivityController<TeamActivity> c=Robolectric.buildActivity(TeamActivity.class,intent("agent:a")).create().start().resume().visible()) {
            TeamActivity a=c.get(); last("list").answer(MEMBERS); input(a).setText("检查入口");
            ((TextView)ReflectionHelpers.getField(a,"send")).performClick();
            Read first=last("send"); String client=first.body.getString("client_id");
            View pending=screenText(a,"正在提交中枢…",true); assertTrue(visible(pending)); assertFalse(text(a.getWindow().getDecorView()).contains("已提交中枢"));
            first.fail("offline","连接中断");
            long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(4);
            do { idle(); layout(a); pending=a.getWindow().getDecorView(); if(label(pending,"确认发送结果")!=null)break; Thread.sleep(1); } while(System.nanoTime()<end);
            assertTrue(text(pending).contains("发送结果未知"));
            touch(a,screenText(a,"确认发送结果",true)); Read retry=last("send"); assertEquals(client,retry.body.getString("client_id"));
            retry.fail("forbidden","未获准");
            end=System.nanoTime()+TimeUnit.SECONDS.toNanos(4);
            do { idle(); layout(a); pending=a.getWindow().getDecorView(); if(label(pending,"保留文字，结束这次发送")!=null)break; Thread.sleep(1); } while(System.nanoTime()<end);
            assertTrue(text(pending).contains("未发出：未获准"));
            assertEquals("检查入口",input(a).getText().toString());
        }
    }
    @Test public void creatingAHelperNeedsOnlyNameRoleAndModelAndKeepsTheReturnedIdentity() throws Exception {
        try(ActivityController<TeamActivity> c=Robolectric.buildActivity(TeamActivity.class,new Intent(RuntimeEnvironment.getApplication(),TeamActivity.class)).create().start().resume().visible()) {
            TeamActivity a=c.get(); last("list").answer(MEMBERS);
            View actions=ReflectionHelpers.getField(a,"actions"); label(actions,"新建").performClick();
            View form=ReflectionHelpers.getField(a,"formSlot");
            field(form,"名字").setText("验收帮手"); field(form,"一句话说明角色").setText("逐项检查应用并回复结果");
            last("runtimes").answer("{\"runtimes\":[{\"kind\":\"dsh\",\"models\":[{\"id\":\"one\"},{\"id\":\"two\"}]}]}");
            last("runtime.catalog").answer("{\"providers\":[{\"models\":[{\"id\":\"one\"},{\"id\":\"two\"}]}]}");
            findSpinner(form,"帮手使用的模型").setSelection(1); idle();
            assertEquals(View.GONE,((View)field(form,"可用工具").getParent()).getVisibility());
            label(form,"保存").performClick(); Read declaration=last("declare");
            String id=declaration.body.getString("id"); assertTrue(id.startsWith("agent:helper-"));
            assertEquals("验收帮手",declaration.body.getString("name"));
            assertEquals("逐项检查应用并回复结果",declaration.body.getString("brief")); assertEquals("two",declaration.body.getJSONObject("runtime").getString("model"));
            declaration.answer("{\"id\":\""+id+"\",\"name\":\"验收帮手\",\"state\":\"idle\",\"notes\":[\"所选模型的密钥尚未配置，当前使用备用模型\"]}");
            assertEquals(id,member(a)); assertEquals(id,ReflectionHelpers.getField(a,"target"));
            last("list").answer("{\"agents\":[{\"id\":\""+id+"\",\"name\":\"验收帮手\",\"summary\":\"逐项检查应用并回复结果\",\"state\":\"idle\"}]}");
            assertNotNull(screenText(a,"配置已保存，中枢提示：所选模型的密钥尚未配置，当前使用备用模型",false));
            c.recreate(); last("list").answer("{\"agents\":[{\"id\":\""+id+"\",\"name\":\"验收帮手\",\"state\":\"idle\"}]}");
            assertNotNull(screenText(c.get(),"配置已保存，中枢提示：所选模型的密钥尚未配置，当前使用备用模型",false));
        }
    }
    @Implements(value = HumanCall.class, isInAndroidSdk = false)
    public static class Port {
        static int clientCalls;
        @Implementation protected void call(Context ctx, String to, String word, JSONObject body, Function2<JSONObject, HumanPort.Failure, Unit> done) { reads.add(new Read(word, body, done)); }
        @Implementation protected void call(LinkClient client, String to, String word, JSONObject body, Function2<JSONObject, HumanPort.Failure, Unit> done) { assertSame(link.getClient(),client); clientCalls++; reads.add(new Read(word, body, done)); }
        @Implementation protected void request(Context ctx, JSONObject request, Function2<JSONObject, HumanPort.Failure, Unit> done) { reads.add(new Read("send", request, done)); }
        @Implementation protected void request(LinkClient client, JSONObject request, Function2<JSONObject, HumanPort.Failure, Unit> done) { assertSame(link.getClient(),client); reads.add(new Read("send", request, done)); }
    }
    @Implements(value = SystemAppActivity.class, isInAndroidSdk = false)
    public static class BaseClient extends org.robolectric.shadows.ShadowActivity {
        @Implementation protected LinkClient getHumanClient() { return link.getClient(); }
    }
    @Implements(value = LedgerFeed.class, isInAndroidSdk = false)
    public static class Feed {
        static Function1<JSONObject,Unit> listener;
        static LinkClient client;
        @Implementation protected void listen(Context ctx, Function1<JSONObject, Unit> message, Function1<Boolean, Unit> connection) { listener=message; connection.invoke(true); }
        @Implementation protected void listen(LinkClient existing, Function1<JSONObject, Unit> message, Function1<Boolean, Unit> connection) { assertSame(link.getClient(),existing); client=existing; listener=message; connection.invoke(true); }
        @Implementation protected void remove(Function1<JSONObject, Unit> message) {}
    }
    @Implements(value = UiIo.class, isInAndroidSdk = false)
    public static class Io {
        @Implementation protected void disk(Function0<Unit> work) { work.invoke(); }
        @Implementation protected void ui(Function0<Unit> work) { work.invoke(); }
    }
}
