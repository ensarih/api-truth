package apitruth;

import com.github.javaparser.JavaParser;
import com.github.javaparser.ParserConfiguration;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.body.ClassOrInterfaceDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.expr.AnnotationExpr;
import com.github.javaparser.ast.expr.ArrayInitializerExpr;
import com.github.javaparser.ast.expr.Expression;
import com.github.javaparser.ast.expr.FieldAccessExpr;
import com.github.javaparser.ast.expr.MarkerAnnotationExpr;
import com.github.javaparser.ast.expr.NormalAnnotationExpr;
import com.github.javaparser.ast.expr.SingleMemberAnnotationExpr;
import com.github.javaparser.ast.expr.StringLiteralExpr;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Inert AST projection. It does not compile, load, resolve, or execute analyzed source. */
public final class AstExtract {
  private static final Set<String> ROUTES = Set.of("GetMapping", "PostMapping", "PutMapping",
      "PatchMapping", "DeleteMapping");
  private static final Set<String> KNOWN = Set.of("RestController", "RequestMapping", "GetMapping",
      "PostMapping", "PutMapping", "PatchMapping", "DeleteMapping");
  private static final Base64.Encoder ENCODER = Base64.getUrlEncoder().withoutPadding();

  private static String enc(String value) {
    return ENCODER.encodeToString(value.getBytes(StandardCharsets.UTF_8));
  }
  private static int line(com.github.javaparser.ast.Node node) {
    return node.getRange().map(range -> range.begin.line).orElse(1);
  }
  private static void diag(int index, int line, String code) {
    System.out.println("D\t" + index + "\t" + line + "\t" + code);
  }
  private static String literal(Expression expression, boolean mediaImported) {
    if (expression instanceof StringLiteralExpr item) {
      String value = item.asString();
      return value.chars().anyMatch(ch -> ch < 32 || ch == 127) ? null : value;
    }
    if (mediaImported && expression instanceof FieldAccessExpr item
        && item.getScope().toString().equals("MediaType")
        && item.getNameAsString().equals("APPLICATION_JSON_VALUE")) return "application/json";
    return null;
  }
  private static List<String> values(Expression expression, boolean mediaImported) {
    List<String> found = new ArrayList<>();
    if (expression instanceof ArrayInitializerExpr array) {
      for (Expression entry : array.getValues()) {
        String value = literal(entry, mediaImported);
        if (value == null) return null;
        found.add(value);
      }
    } else {
      String value = literal(expression, mediaImported);
      if (value == null) return null;
      found.add(value);
    }
    return found;
  }
  private static Map<String, List<String>> arguments(AnnotationExpr annotation, boolean mediaImported) {
    Map<String, List<String>> result = new HashMap<>();
    if (annotation instanceof MarkerAnnotationExpr) return result;
    if (annotation instanceof SingleMemberAnnotationExpr single) {
      result.put("value", values(single.getMemberValue(), mediaImported));
      return result;
    }
    if (annotation instanceof NormalAnnotationExpr normal) {
      for (var pair : normal.getPairs()) {
        if (result.containsKey(pair.getNameAsString())) return null;
        result.put(pair.getNameAsString(), values(pair.getValue(), mediaImported));
      }
      return result;
    }
    return null;
  }
  private static String one(Map<String, List<String>> args, String name) {
    List<String> values = args.get(name);
    return values == null || values.size() != 1 ? null : values.get(0);
  }
  private static boolean supported(Map<String, List<String>> args) {
    if (args == null || args.keySet().stream().anyMatch(key ->
        !Set.of("value", "path", "headers", "consumes", "produces").contains(key))) return false;
    for (var entry : args.entrySet()) if ((entry.getValue() == null
        && !Set.of("value", "path").contains(entry.getKey()))
        || entry.getValue() != null && entry.getValue().isEmpty()) return false;
    return !(args.containsKey("value") && args.containsKey("path"));
  }
  private static String joined(List<String> values) {
    return values == null ? "" : String.join("\u0000", values);
  }
  private static void analyze(int index, Path path, Set<String> serviceAnnotations,
      boolean mediaShadowed) throws Exception {
    var parsed = new JavaParser(new ParserConfiguration()
        .setLanguageLevel(ParserConfiguration.LanguageLevel.JAVA_21)).parse(path);
    if (!parsed.isSuccessful() || parsed.getResult().isEmpty()) {
      diag(index, 1, "source_syntax_unsupported"); return;
    }
    CompilationUnit unit = parsed.getResult().get();
    Set<String> imports = new java.util.HashSet<>();
    unit.getImports().forEach(item -> imports.add(item.getNameAsString()));
    boolean mediaImported = imports.contains("org.springframework.http.MediaType") && !mediaShadowed;
    if (!serviceAnnotations.isEmpty()) {diag(index, 1, "annotation_shadowing_unsupported"); return;}
    for (ClassOrInterfaceDeclaration controller : unit.findAll(ClassOrInterfaceDeclaration.class)) {
      if (!controller.isTopLevelType()) {diag(index, line(controller), "nested_controller_unsupported"); continue;}
      if (controller.getAnnotationByName("RestController").isEmpty()) continue;
      if (!imports.contains("org.springframework.web.bind.annotation.RestController")) {
        diag(index, line(controller), "controller_import_unresolved"); continue;
      }
      if (!controller.getExtendedTypes().isEmpty() || !controller.getImplementedTypes().isEmpty()) {
        diag(index, line(controller), "controller_inheritance_unsupported"); continue;
      }
      String prefix = "";
      List<String> classProduces = null;
      List<String> classConsumes = null;
      var classMapping = controller.getAnnotationByName("RequestMapping");
      if (controller.getAnnotations().stream().anyMatch(item -> ROUTES.contains(item.getNameAsString()))) {
        diag(index, line(controller), "controller_mapping_combination_unsupported"); continue;
      }
      if (classMapping.isPresent()) {
        if (!imports.contains("org.springframework.web.bind.annotation.RequestMapping")) {
          diag(index, line(controller), "mapping_import_unresolved"); continue;
        }
        var args = arguments(classMapping.get(), mediaImported);
        if (!supported(args) || args.containsKey("headers")) {
          diag(index, line(classMapping.get()), "class_mapping_unsupported"); continue;
        }
        if (args.containsKey("value") || args.containsKey("path")) {
          prefix = one(args, args.containsKey("path") ? "path" : "value");
          if (prefix == null) {diag(index, line(classMapping.get()), "class_path_dynamic"); continue;}
        }
        classProduces = args.get("produces"); classConsumes = args.get("consumes");
      }
      for (MethodDeclaration method : controller.getMethods()) {
        List<AnnotationExpr> routes = method.getAnnotations().stream()
            .filter(item -> ROUTES.contains(item.getNameAsString())).toList();
        if (routes.isEmpty()) {
          if (method.getAnnotationByName("RequestMapping").isPresent())
            diag(index, line(method), "method_request_mapping_unsupported");
          continue;
        }
        if (method.getAnnotationByName("RequestMapping").isPresent()) {
          diag(index, line(method), "method_mapping_combination_unsupported"); continue;
        }
        if (routes.size() != 1 || method.getBody().isEmpty()) {
          diag(index, line(method), "route_ambiguous_or_unimplemented"); continue;
        }
        AnnotationExpr route = routes.get(0);
        String annotation = route.getNameAsString();
        if (!imports.contains("org.springframework.web.bind.annotation." + annotation)) {
          diag(index, line(route), "route_import_unresolved"); continue;
        }
        Map<String, List<String>> args = arguments(route, mediaImported);
        if (!supported(args)) {diag(index, line(route), "route_mapping_unsupported"); continue;}
        String suffix = "";
        if (args.containsKey("value") || args.containsKey("path")) {
          suffix = one(args, args.containsKey("path") ? "path" : "value");
          if (suffix == null) {diag(index, line(route), "route_path_dynamic"); continue;}
        }
        List<String> headers = args.get("headers");
        List<String> consumes = args.containsKey("consumes") ? args.get("consumes") : classConsumes;
        List<String> produces = args.containsKey("produces") ? args.get("produces") : classProduces;
        String methodName = annotation.substring(0, annotation.length() - "Mapping".length()).toUpperCase();
        var range = route.getRange().orElseThrow();
        System.out.println("R\t" + index + "\t" + range.begin.line + "\t" + range.begin.column
            + "\t" + range.end.line + "\t" + range.end.column + "\t" + line(controller)
            + "\t" + line(method) + "\t" + methodName + "\t" + enc(prefix)
            + "\t" + enc(suffix) + "\t" + enc(joined(headers)) + "\t"
            + enc(joined(consumes)) + "\t" + enc(joined(produces)) + "\t"
            + enc(method.getNameAsString()));
      }
    }
  }
  public static void main(String[] paths) {
    if (paths.length < 1 || paths.length > 200) System.exit(2);
    Set<String> serviceAnnotations = new java.util.HashSet<>();
    boolean mediaShadowed = false;
    for (String path : paths) {
      try {
        var parsed = new JavaParser(new ParserConfiguration()
            .setLanguageLevel(ParserConfiguration.LanguageLevel.JAVA_21)).parse(Path.of(path));
        if (parsed.getResult().isPresent()) {
          var unit = parsed.getResult().get();
          unit.findAll(com.github.javaparser.ast.body.AnnotationDeclaration.class).stream()
              .map(item -> item.getNameAsString()).filter(KNOWN::contains).forEach(serviceAnnotations::add);
          if (unit.findAll(com.github.javaparser.ast.body.TypeDeclaration.class).stream()
              .anyMatch(item -> item.getNameAsString().equals("MediaType"))) mediaShadowed = true;
          if (unit.findAll(com.github.javaparser.ast.body.VariableDeclarator.class).stream()
              .anyMatch(item -> item.getNameAsString().equals("MediaType"))) mediaShadowed = true;
          if (unit.findAll(com.github.javaparser.ast.body.Parameter.class).stream()
              .anyMatch(item -> item.getNameAsString().equals("MediaType"))) mediaShadowed = true;
        }
      } catch (Throwable ignored) { /* the main parse reports the source failure */ }
    }
    for (int index = 0; index < paths.length; index++) {
      try {analyze(index, Path.of(paths[index]), serviceAnnotations, mediaShadowed);}
      catch (Throwable ignored) {diag(index, 1, "java_parser_failure");}
    }
  }
}
