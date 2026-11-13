package com.smartcare.backend.controller;

import com.smartcare.backend.entity.NursingGoalRecord;
import com.smartcare.backend.service.NursingGoalRecordService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.CrossOrigin;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * 重症患者护理目标管理记录（新增/编辑/删除）。
 */
@RestController
@RequestMapping("/api/v1/icu/nursing-goal-records")
@CrossOrigin(origins = "*")
public class NursingGoalRecordController {
    private final NursingGoalRecordService service;

    public NursingGoalRecordController(NursingGoalRecordService service) {
        this.service = service;
    }

    @GetMapping("/listByPid")
    public ResponseEntity<List<NursingGoalRecord>> listByPid(@RequestParam String pid) {
        return ResponseEntity.ok(service.listValid(pid));
    }

    @PostMapping("/save")
    public ResponseEntity<NursingGoalRecord> save(@RequestBody NursingGoalRecord body) {
        return ResponseEntity.ok(service.save(body));
    }

    @PatchMapping("/{id}/invalidate")
    public ResponseEntity<Void> invalidate(@PathVariable String id,
                                           @RequestParam(required = false) String operatorId) {
        service.invalidate(id, operatorId);
        return ResponseEntity.noContent().build();
    }
}
