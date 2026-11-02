package com.smartcare.backend.controller;

import com.smartcare.backend.entity.CrrtOrderFormRecord;
import com.smartcare.backend.service.CrrtOrderFormService;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping({"/api/v1/icu/crrt-orders"})
@CrossOrigin(origins = {"*"})
public class CrrtOrderFormController {
    private final CrrtOrderFormService service;

    public CrrtOrderFormController(CrrtOrderFormService service) { this.service = service; }

    @GetMapping("/patient/{pid}")
    public ResponseEntity<List<Map<String, Object>>> listByPid(@PathVariable String pid) {
        List<Map<String, Object>> summaries = service.findByPid(pid).stream()
            .map(r -> {
                Map<String, Object> m = new java.util.LinkedHashMap<>();
                m.put("id", r.getId());
                m.put("orderTime", r.getOrderTime());
                m.put("updatedAt", r.getUpdatedAt());
                return m;
            })
            .collect(Collectors.toList());
        return ResponseEntity.ok(summaries);
    }

    @GetMapping("/{id}")
    public ResponseEntity<CrrtOrderFormRecord> getById(@PathVariable String id) {
        return service.findById(id).map(ResponseEntity::ok).orElse(ResponseEntity.notFound().build());
    }

    @PostMapping
    public ResponseEntity<?> create(@RequestBody CrrtOrderFormRecord body, @RequestParam(defaultValue = "") String operatorId) {
        body.setId(null);
        try {
            return ResponseEntity.ok(service.save(body, operatorId));
        } catch (CrrtOrderFormService.DuplicateCrrtOrderTimeException e) {
            return ResponseEntity.status(409).body(Map.of("message", e.getMessage()));
        }
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<?> delete(@PathVariable String id, @RequestParam(defaultValue = "") String operatorId) {
        if (service.findById(id).isEmpty()) {
            return ResponseEntity.notFound().build();
        }
        service.delete(id);
        return ResponseEntity.ok(Map.of("message", "删除成功"));
    }

    @PutMapping("/{id}")
    public ResponseEntity<?> update(@PathVariable String id, @RequestBody CrrtOrderFormRecord body, @RequestParam(defaultValue = "") String operatorId) {
        try {
            body.setId(id);
            return ResponseEntity.ok(service.save(body, operatorId));
        } catch (org.springframework.dao.OptimisticLockingFailureException e) {
            return ResponseEntity.status(409).body(Map.of("message", "该医嘱单已被其他人员修改，请重新加载后再保存。"));
        }
    }
}
