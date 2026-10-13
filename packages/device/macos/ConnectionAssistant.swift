import AppKit
import WebKit
import CryptoKit
import Darwin

private let maximumFrame = 65536
private struct Pending { let timer: DispatchWorkItem; var responded: Bool = false }
final class ConnectionAssistant: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate, NSWindowDelegate {
 private let runtimeHome:URL
 private let runtimeTemp:String
 override init(){runtimeHome=FileManager.default.homeDirectoryForCurrentUser;runtimeTemp=NSTemporaryDirectory();super.init()}
 #if SETUP_ISOLATION_HARNESS
 init(_ proof:VerifiedSetupHarnessHome){runtimeHome=proof.home;runtimeTemp=proof.home.path;super.init()}
 private var harnessStarted=false,harnessForwarded=0
 #endif
 private var window: NSWindow!; private var web: WKWebView!; private var child: Process?; private var input: FileHandle?; private var output: FileHandle?; private var bytes=Data(); private var pending=[String:Pending](); private var session=UUID().uuidString; private var closed=false; private var sheetRequest:String?; private var index: URL!; private var resources: URL!
 func applicationDidFinishLaunching(_ notification: Notification) {
  NSApp.setActivationPolicy(.regular)
  let menu=NSMenu(),item=NSMenuItem(),appMenu=NSMenu();menu.addItem(item);item.submenu=appMenu;appMenu.addItem(withTitle:"退出设置窗口",action:#selector(NSApplication.terminate(_:)),keyEquivalent:"q");NSApp.mainMenu=menu
  window=NSWindow(contentRect:NSRect(x:0,y:0,width:850,height:800),styleMask:[.titled,.closable,.miniaturizable,.resizable],backing:.buffered,defer:false);window.title="Ash 电脑连接助手";window.delegate=self;window.center()
  do {
   guard let suppliedRoot=Bundle.main.resourceURL else { throw ShellFailure.invalid }; let root=try physicalURL(suppliedRoot); resources=root
   try verifyBundle(root)
   index=root.appendingPathComponent("setup/index.html")
   let config=WKWebViewConfiguration();config.websiteDataStore = .nonPersistent();config.preferences.javaScriptCanOpenWindowsAutomatically=false
   config.userContentController.add(self,name:"setup")
   config.userContentController.addUserScript(WKUserScript(source:"Object.defineProperty(globalThis,'__ashSetupSession',{value:'\(session)',writable:false});",injectionTime:.atDocumentStart,forMainFrameOnly:true))
   web=WKWebView(frame:window.contentView!.bounds,configuration:config);web.autoresizingMask=[.width,.height];web.navigationDelegate=self;window.contentView=web
   try launchBridge(root)
   web.loadFileURL(index,allowingReadAccessTo:root.appendingPathComponent("setup",isDirectory:true))
  } catch {
   #if SETUP_ISOLATION_HARNESS
   SetupHarness.phase("failed",code:"bundle_or_bridge_startup")
   DispatchQueue.main.async {self.window.close()}
   #endif
   let label=NSTextField(wrappingLabelWithString:"设置组件缺失或完整性核验失败。请使用完整的连接助手发行包。后台助手和原客户端未被修改。");label.frame=NSRect(x:40,y:340,width:740,height:120);window.contentView?.addSubview(label) }
  window.makeKeyAndOrderFront(nil);NSApp.activate(ignoringOtherApps:true)
 }
 private enum ShellFailure: Error { case invalid }
 private func physicalURL(_ supplied:URL) throws -> URL {
  guard let pointer=Darwin.realpath(supplied.path,nil) else{throw ShellFailure.invalid};defer{free(pointer)}
  return URL(fileURLWithPath:String(cString:pointer),isDirectory:supplied.hasDirectoryPath)
 }
 private func verifyBundle(_ root:URL) throws {
  guard try physicalURL(root).path==root.path else {throw ShellFailure.invalid}
  var directory=stat();guard lstat(root.path,&directory)==0,(directory.st_mode&S_IFMT)==S_IFDIR,(directory.st_uid==getuid() || directory.st_uid==0),(directory.st_mode&0o022)==0 else{throw ShellFailure.invalid}
  let manifestURL=root.appendingPathComponent("shell-manifest.json")
  let metadata=try JSONSerialization.jsonObject(with:readRegular(manifestURL,limit:8192)) as? [String:Any]
  let allowed=["node","shell-bridge.mjs","setup/index.html","setup/setup.js","setup/setup.css"]
  guard let m=metadata,m.count==2,(m["version"] as? Int)==1,let hashes=m["sha256"] as? [String:String],Set(hashes.keys)==Set(allowed) else {throw ShellFailure.invalid}
  for path in allowed {let url=root.appendingPathComponent(path);guard try physicalURL(url).path==url.path else {throw ShellFailure.invalid};let data=try readRegular(url,limit:path=="node" ? 256*1024*1024:4*1024*1024);let hash=SHA256.hash(data:data).map{String(format:"%02x",$0)}.joined();guard hashes[path]==hash else {throw ShellFailure.invalid}}
 }
 private func readRegular(_ url:URL,limit:Int) throws -> Data {
  guard try physicalURL(url).path==url.path else{throw ShellFailure.invalid}
  let fd=Darwin.open(url.path,O_RDONLY|O_NOFOLLOW|O_NONBLOCK);guard fd>=0 else{throw ShellFailure.invalid};defer{Darwin.close(fd)}
  var before=stat(),after=stat(),named=stat()
  guard fstat(fd,&before)==0,(before.st_mode & S_IFMT)==S_IFREG,before.st_nlink==1,(before.st_uid==getuid() || before.st_uid==0),before.st_size>0,before.st_size<=limit,(before.st_mode & 0o022)==0 else{throw ShellFailure.invalid}
  var data=Data(),buffer=[UInt8](repeating:0,count:65536)
  while true {let count=Darwin.read(fd,&buffer,min(buffer.count,limit-data.count+1));if count<0{throw ShellFailure.invalid};if count==0{break};data.append(contentsOf:buffer.prefix(count));if data.count>limit{throw ShellFailure.invalid}}
  guard try physicalURL(url).path==url.path,fstat(fd,&after)==0,lstat(url.path,&named)==0,(named.st_mode&S_IFMT)==S_IFREG,after.st_dev==before.st_dev,after.st_ino==before.st_ino,named.st_ino==before.st_ino,named.st_dev==before.st_dev,after.st_size==before.st_size,data.count==before.st_size,after.st_nlink==1,after.st_uid==before.st_uid,after.st_mode==before.st_mode,after.st_mtimespec.tv_sec==before.st_mtimespec.tv_sec,after.st_mtimespec.tv_nsec==before.st_mtimespec.tv_nsec,after.st_ctimespec.tv_sec==before.st_ctimespec.tv_sec,after.st_ctimespec.tv_nsec==before.st_ctimespec.tv_nsec else{throw ShellFailure.invalid};return data
 }
 private func launchBridge(_ root:URL) throws {
  let process=Process(),stdin=Pipe(),stdout=Pipe(),stderr=Pipe()
  process.executableURL=root.appendingPathComponent("node");process.arguments=[root.appendingPathComponent("shell-bridge.mjs").path]
  process.environment=["HOME":runtimeHome.path,"TMPDIR":runtimeTemp,"PATH":"/usr/bin:/bin","LANG":"en_US.UTF-8"]
  process.currentDirectoryURL=root;process.standardInput=stdin;process.standardOutput=stdout;process.standardError=stderr
  input=stdin.fileHandleForWriting;output=stdout.fileHandleForReading
  stdout.fileHandleForReading.readabilityHandler={ [weak self] handle in let data=handle.availableData;DispatchQueue.main.async {self?.receive(data)}}
  // Never relay raw dependency stderr, configuration paths, or private auth data.
  stderr.fileHandleForReading.readabilityHandler={handle in _=handle.availableData}
  process.terminationHandler={ [weak self] _ in DispatchQueue.main.async {self?.bridgeEnded()}}
  try process.run();child=process
 }
 func webView(_ webView: WKWebView,decidePolicyFor navigationAction:WKNavigationAction,decisionHandler:@escaping(WKNavigationActionPolicy)->Void){guard !closed,navigationAction.targetFrame?.isMainFrame==true,navigationAction.request.url?.standardizedFileURL==index.standardizedFileURL else {decisionHandler(.cancel);return};decisionHandler(.allow)}
 func userContentController(_ userContentController:WKUserContentController,didReceive message:WKScriptMessage){
  guard !closed,message.name=="setup",message.frameInfo.isMainFrame,message.frameInfo.request.url?.standardizedFileURL==index.standardizedFileURL,let body=message.body as? [String:Any],Set(body.keys)==Set(["session","id","method","body"]),body["session"] as? String==session,let id=body["id"] as? String,id.range(of:"^[-A-Za-z0-9_]{1,128}$",options:.regularExpression) != nil,let method=body["method"] as? String,["status","choose-directory","prepare","apply"].contains(method),let args=body["body"] as? [String:Any],let encoded=try? JSONSerialization.data(withJSONObject:body),encoded.count<=maximumFrame else {return}
  guard pending[id]==nil,pending.count<8 else {reply(id,ok:false,result:["code":"busy"]);return}
  let timer=DispatchWorkItem { [weak self] in guard let self=self,var p=self.pending[id],!p.responded else{return};p.responded=true;self.pending[id]=p;self.reply(id,ok:false,result:["code":method=="apply" ? "result_unknown":"unavailable"]);if self.sheetRequest==id,let sheet=self.window.attachedSheet {self.window.endSheet(sheet,returnCode:.cancel)}}
  pending[id]=Pending(timer:timer);DispatchQueue.main.asyncAfter(deadline:.now()+31,execute:timer)
  if method=="choose-directory" {guard args.isEmpty,window.attachedSheet==nil else {finishNative(id,ok:false,result:["code":"invalid"]);return};let panel=NSOpenPanel();panel.canChooseFiles=false;panel.canChooseDirectories=true;panel.allowsMultipleSelection=false;panel.canCreateDirectories=false;sheetRequest=id;let captured=session
   #if SETUP_ISOLATION_HARNESS
   panel.directoryURL=runtimeHome.appendingPathComponent("project")
   #endif
   panel.beginSheetModal(for:window){ [weak self] result in guard let self=self,!self.closed,self.session==captured,self.pending[id]?.responded==false else {self?.discardPending(id);return}
   #if SETUP_ISOLATION_HARNESS
   if result == .OK{SetupHarness.selectedPanels+=1}else{SetupHarness.cancelledPanels+=1}
   #endif
   guard result == .OK,let url=panel.url else {self.finishNative(id,ok:true,result:["cancelled":true]);return};self.forward(id,method:method,body:["path":url.resolvingSymlinksInPath().path])}
   #if SETUP_ISOLATION_HARNESS
   SetupHarness.drivePanel(panel)
   #endif
   return}
  if method=="apply" {guard window.attachedSheet==nil,Set(args.keys)==Set(["preview_id","selection_hash"]),args["preview_id"] is String,args["selection_hash"] is String else {finishNative(id,ok:false,result:["code":"invalid"]);return};let alert=NSAlert();alert.messageText="明确保存所预览的整份授权？";alert.informativeText="此次保存会替换预览中列出的读取或控制范围。不会启动模型任务。";alert.addButton(withTitle:"保存授权");alert.addButton(withTitle:"取消");sheetRequest=id;let captured=session;alert.beginSheetModal(for:window){[weak self] result in guard let self=self,!self.closed,self.session==captured,self.pending[id]?.responded==false else{self?.discardPending(id);return};if result == .alertFirstButtonReturn {
   #if SETUP_ISOLATION_HARNESS
   SetupHarness.confirmedAlerts+=1
   #endif
   self.forward(id,method:method,body:args)}else{self.finishNative(id,ok:false,result:["code":"cancelled"])}}
   #if SETUP_ISOLATION_HARNESS
   SetupHarness.driveAlert(alert)
   #endif
   return}
  // prepare carries only native-issued directory IDs or retention of private current single_work.
  forward(id,method:method,body:args)
 }
 private func forward(_ id:String,method:String,body:[String:Any]) {
  guard !closed,child?.isRunning==true,pending[id]?.responded==false,let data=try? JSONSerialization.data(withJSONObject:["id":id,"method":method,"body":body]),data.count<=maximumFrame else{finishNative(id,ok:false,result:["code":"unavailable"]);return}
  let timer=pending[id]!.timer
  #if SETUP_ISOLATION_HARNESS
  harnessForwarded+=1
  #endif
  do{try input?.write(contentsOf:data+Data([10]))}catch{timer.cancel();pending.removeValue(forKey:id);reply(id,ok:false,result:["code":"unavailable"])}
 }
 private func discardPending(_ id:String){pending.removeValue(forKey:id)?.timer.cancel();if sheetRequest==id{sheetRequest=nil}}
 private func finishNative(_ id:String,ok:Bool,result:Any){discardPending(id);reply(id,ok:ok,result:result)}
 private func receive(_ data:Data){guard !closed else{return};if data.isEmpty {bridgeEnded();return};bytes.append(data)
  while let end=bytes.firstIndex(of:10){let line=bytes.prefix(upTo:end);bytes.removeSubrange(...end);guard line.count<=maximumFrame,let value=try? JSONSerialization.jsonObject(with:line) as? [String:Any],let id=value["id"] as? String,let ok=value["ok"] as? Bool,let p=pending.removeValue(forKey:id) else {bridgeEnded();return};p.timer.cancel();if !p.responded {reply(id,ok:ok,result:ok ? (value["result"] ?? NSNull()):(value["error"] ?? ["code":"unavailable"]))}}
  if bytes.count>maximumFrame {bridgeEnded()}
 }
 #if SETUP_ISOLATION_HARNESS
 func webView(_ webView:WKWebView,didFinish navigation:WKNavigation!){guard !harnessStarted else{return};harnessStarted=true;Task {await runHarness()}}
 @MainActor private func js(_ script:String,arguments:[String:Any]=[:]) async throws -> Any {try await withCheckedThrowingContinuation { (continuation:CheckedContinuation<Any,Error>) in web.callAsyncJavaScript(script,arguments:arguments,in:nil,in:.page,completionHandler:{continuation.resume(with:$0)})}}
 @MainActor private func waitNotice(_ text:String) async throws {let end=Date().addingTimeInterval(20);while Date()<end {if let value=try await js("return document.getElementById('notice').textContent" ) as? String,value.contains(text){return};try await Task.sleep(nanoseconds:50_000_000)};throw NSError(domain:"harness",code:1)}
 @MainActor private func runHarness() async {do{
  try await waitNotice("当前范围已读取");SetupHarness.phase("status")
  if SetupHarness.guardsOnly{try await runGuards();window.close();return}
  if SetupHarness.inventoryOnly{SetupHarness.identity();try await Task.sleep(nanoseconds:60_000_000_000);SetupHarness.phase("inventory-complete");window.close();return}
  _=try await js("document.getElementById('read-add').click()");try await waitForDirectory();SetupHarness.phase("selected")
  _=try await js("document.getElementById('read-preview').click()");try await waitNotice("预览已核验");_ = try await js("document.getElementById('cancel').click()");SetupHarness.phase("preview-cancelled")
  _=try await js("document.getElementById('read-preview').click()");try await waitNotice("预览已核验");_=try await js("document.getElementById('save').click()");try await waitNotice("已保存");SetupHarness.phase("saved")
  SetupHarness.cancelNextPanel=true;_=try await js("document.getElementById('read-add').click()");let cancelDeadline=Date().addingTimeInterval(SetupHarness.manualDrive ? 60:10);while SetupHarness.cancelledPanels==0 && Date()<cancelDeadline{try await Task.sleep(nanoseconds:50_000_000)}
  guard SetupHarness.selectedPanels==1,SetupHarness.cancelledPanels==1,SetupHarness.confirmedAlerts==1 else{throw NSError(domain:"harness",code:2)}
  let snapshot:NSImage=try await withCheckedThrowingContinuation { continuation in web.takeSnapshot(with:nil){image,error in if let image=image{continuation.resume(returning:image)}else{continuation.resume(throwing:error ?? NSError(domain:"harness",code:4))}}};if let data=snapshot.tiffRepresentation,let bitmap=NSBitmapImageRep(data:data),let png=bitmap.representation(using:.png,properties:[:]){try png.write(to:runtimeHome.appendingPathComponent("wk.png"))}
  SetupHarness.phase("complete");window.close()
 }catch{SetupHarness.phase("failed",code:"native_ui_or_scope-"+String((error as NSError).code));window.close()}}
 @MainActor private func runGuards() async throws {
  let initial=try await js("return location.href") as? String,baseline=harnessForwarded
  _=try await js(#"""
  const post=(id,method,body,session=globalThis.__ashSetupSession)=>webkit.messageHandlers.setup.postMessage({session,id,method,body});
  post('wk-unknown','exec',{});post('wk-wrong-session','status',{},'wrong-session');post('wk-oversized','status',{padding:'x'.repeat(65536)});
  const frame=document.createElement('iframe');frame.srcdoc='<script>webkit.messageHandlers.setup.postMessage({session:parent.__ashSetupSession,id:"wk-frame",method:"status",body:{}})</script>';document.body.append(frame);return true;
  """#)
  try await Task.sleep(nanoseconds:200_000_000)
  guard harnessForwarded==baseline,pending.isEmpty else{throw NSError(domain:"harness",code:10)}
  SetupHarness.phase("wk-message-guards")
  for target in ["http://127.0.0.1:9/",index.deletingLastPathComponent().appendingPathComponent("setup.css").absoluteString] {
   _=try await js("location.href=target;return true",arguments:["target":target]);try await Task.sleep(nanoseconds:200_000_000)
   guard try await js("return location.href") as? String==initial,harnessForwarded==baseline,pending.isEmpty else{throw NSError(domain:"harness",code:11)}
  }
  SetupHarness.phase("wk-navigation-guards")
  let snapshot:NSImage=try await withCheckedThrowingContinuation {continuation in web.takeSnapshot(with:nil){image,error in if let image=image{continuation.resume(returning:image)}else{continuation.resume(throwing:error ?? NSError(domain:"harness",code:12))}}}
  guard let data=snapshot.tiffRepresentation,let bitmap=NSBitmapImageRep(data:data),let png=bitmap.representation(using:.png,properties:[:]) else{throw NSError(domain:"harness",code:13)}
  try png.write(to:runtimeHome.appendingPathComponent("wk.png"));SetupHarness.phase("guards-complete")
 }
 @MainActor private func waitForDirectory() async throws {let end=Date().addingTimeInterval(SetupHarness.manualDrive ? 60:10);while Date()<end {if let count=try await js("return document.querySelectorAll('#read-dirs li').length") as? Int,count==1{return};try await Task.sleep(nanoseconds:50_000_000)};throw NSError(domain:"harness",code:3)}
 #endif
 private func reply(_ id:String,ok:Bool,result:Any){guard !closed,web != nil else{return};let message:[String:Any]=["session":session,"id":id,"ok":ok,ok ? "result":"error":result];web.callAsyncJavaScript("globalThis.__ashSetupReceive(message)",arguments:["message":message],in:nil,in:.page,completionHandler:nil)}
 private func bridgeEnded(){guard !closed else{return};for(id,p) in pending{p.timer.cancel();if !p.responded{reply(id,ok:false,result:["code":"result_unknown"])}};pending.removeAll();output?.readabilityHandler=nil;child?.terminate();child=nil}
 func windowWillClose(_ notification:Notification){stop();NSApp.terminate(nil)}
 func applicationWillTerminate(_ notification:Notification){stop()}
 private func stop(){if closed{return};closed=true;session=UUID().uuidString;for p in pending.values{p.timer.cancel()};pending.removeAll();web?.configuration.userContentController.removeScriptMessageHandler(forName:"setup");output?.readabilityHandler=nil;try? input?.close();child?.terminate();child=nil}
}
#if !SETUP_ISOLATION_HARNESS
@main enum ProductionConnectionAssistant {static func main(){let app=NSApplication.shared;let delegate=ConnectionAssistant();app.delegate=delegate;app.run()}}
#endif
