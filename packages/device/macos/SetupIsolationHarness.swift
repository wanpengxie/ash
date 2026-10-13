// Included only in the separate fixture executable. Production does not compile this entry.
import AppKit
import Darwin
final class VerifiedSetupHarnessHome {
 let home:URL
 init() throws {
  var file=stat();guard fstat(3,&file)==0,(file.st_mode&S_IFMT)==S_IFREG,file.st_uid==getuid(),file.st_nlink==1,(file.st_mode&0o777)==0o600,file.st_size>0,file.st_size<4096 else{throw NSError(domain:"harness",code:1)}
  let handle=FileHandle(fileDescriptor:3,closeOnDealloc:true),data=try handle.readToEnd() ?? Data();guard data.count==file.st_size,let value=try JSONSerialization.jsonObject(with:data) as? [String:Any],Set(value.keys)==Set(["version","home"]),value["version"] as? Int==1,let path=value["home"] as? String,path.range(of:"^/private/tmp/ash-wk-[A-Za-z0-9]+$",options:.regularExpression) != nil else{throw NSError(domain:"harness",code:2)}
  home=URL(fileURLWithPath:path,isDirectory:true);guard let resolved=path.withCString({Darwin.realpath($0,nil)}) else{throw NSError(domain:"harness",code:3)};defer{free(resolved)};guard String(cString:resolved)==path,home.path==path else{throw NSError(domain:"harness",code:3)};var directory=stat(),named=stat();guard lstat(path,&directory)==0,(directory.st_mode&S_IFMT)==S_IFDIR,directory.st_uid==getuid(),(directory.st_mode&0o777)==0o700,lstat(path+"/launch.json",&named)==0,named.st_dev==file.st_dev,named.st_ino==file.st_ino else{throw NSError(domain:"harness",code:4)}
 }
}
@main enum SetupHarness {
 static var selectedPanels=0,cancelledPanels=0,confirmedAlerts=0,cancelNextPanel=false
 static func phase(_ stage:String,code:String?=nil){var value:[String:Any]=["stage":stage,"pid":getpid(),"utc":ISO8601DateFormatter().string(from:Date())];if let code=code {value["code"]=code};if stage=="complete" {value["selected_panels"]=selectedPanels;value["cancelled_panels"]=cancelledPanels;value["confirmed_alerts"]=confirmedAlerts};let data=try! JSONSerialization.data(withJSONObject:value);FileHandle.standardOutput.write(data+Data([10]))}
 static var manualDrive=false,inventoryOnly=false,guardsOnly=false
 static func identity(){let app=NSRunningApplication.current;let value:[String:Any]=["stage":"native-app-identity","utc":ISO8601DateFormatter().string(from:Date()),"pid":getpid(),"bundle_id":app.bundleIdentifier as Any? ?? NSNull(),"bundle_url":app.bundleURL?.path as Any? ?? NSNull(),"activation_policy":app.activationPolicy.rawValue,"finished_launching":app.isFinishedLaunching,"workspace_present":NSWorkspace.shared.runningApplications.contains(where:{$0.processIdentifier==getpid()})];let data=try! JSONSerialization.data(withJSONObject:value);FileHandle.standardOutput.write(data+Data([10]))}
 static func drivePanel(_ panel:NSOpenPanel){DispatchQueue.main.asyncAfter(deadline:.now()+0.3){
  let cancel=cancelNextPanel;cancelNextPanel=false
  var classes=[String](),buttons=[NSButton]()
  func inspect(_ view:NSView){guard classes.count<64 else{return};classes.append(String(describing:type(of:view)));if let button=view as? NSButton {buttons.append(button)};for child in view.subviews{inspect(child)}}
  if let content=panel.contentView{inspect(content)}
  phase("native-panel-view",code:classes.joined(separator:","))
  if manualDrive{phase("awaiting-native-panel",code:cancel ? "cancel":"choose");return}
  let key=cancel ? "\u{1b}":"\r"
  if let button=buttons.first(where:{$0.isEnabled && $0.keyEquivalent==key}){phase("native-panel-action",code:"public-view-button");button.performClick(nil);return}
  // Own-object public accessibility action; never asks for or changes global AX trust.
  let performed=cancel ? panel.accessibilityPerformCancel():panel.accessibilityPerformConfirm()
  phase("native-panel-action",code:performed ? "accepted":"unavailable")
 }}
 static func driveAlert(_ alert:NSAlert){DispatchQueue.main.asyncAfter(deadline:.now()+0.3){alert.buttons.first?.performClick(nil)}}
 static func main(){do{let proof=try VerifiedSetupHarnessHome();phase("verified-temp-root");let args=Array(CommandLine.arguments.dropFirst());guard args.isEmpty || args==["--proof-only"] || args==["--manual-panel"] || args==["--inventory-only"] || args==["--guards-only"] else{throw NSError(domain:"harness",code:5)};if args==["--proof-only"] {exit(0)};manualDrive=args==["--manual-panel"];inventoryOnly=args==["--inventory-only"];guardsOnly=args==["--guards-only"];let app=NSApplication.shared,delegate=ConnectionAssistant(proof);app.delegate=delegate;app.run()}catch{phase("failed",code:"invalid-private-descriptor-"+String((error as NSError).code));exit(2)}}
}
